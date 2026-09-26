/**
 * 支付回调路由契约测试（`/api/v1/callbacks/*`，`docs/06` §6 / `docs/08` §8.2）。
 *
 * ## 覆盖的硬性契约
 *
 * 1. **无鉴权**（`docs/06:14`）——不带任何令牌也能进到业务逻辑（**不返回 401**）。
 * 2. **验签**：缺 `Wechatpay-*` 头 → `ERR_CALLBACK_SIGNATURE_MISSING`；
 *    时间戳超容忍窗口（`CALLBACK_TIMESTAMP_TOLERANCE_SECONDS`）→ `ERR_CALLBACK_TIMESTAMP_EXPIRED`；
 *    平台公钥**未配置** → `ERR_CALLBACK_SIGNATURE_INVALID`（安全侧默认）。
 * 3. **合法签名 → 成功**：真造一对 RSA 密钥、按微信 v3 规范签名，
 *    并用 `WXPAY_V3_KEY` 加密 `resource`，验证「验签 + 解密 + 记账」全链路。
 * 4. ★ **幂等**：同一 `channel_trade_no` 二次回调**仍返回成功**，
 *    且 `payments` 不重复插入、库存不重复扣减（`docs/08` §8.2）。
 * 5. **应答格式**：微信返回 JSON 且 `code === "SUCCESS"`；
 *    支付宝返回**纯文本** `success`（`content-type` 非 JSON）。
 * 6. **两套路径都可达**：`/payment/wechat` 与 `wechat-pay`（`docs/06` 别名）。
 *
 * ## 与真实渠道的差异（诚实登记）
 *
 * 用 WebCrypto 现场生成 RSA-2048 密钥对并自签，**不接真实 SDK**（任务要求）。
 * 微信 v3 的 `resource` 用真实 `AEAD_AES_256_GCM` 加密，解密路径与生产同源。
 */

import { JWT_AUDIENCE } from "@dshop/shared";
import {
  CALLBACK_ERROR_CODES,
  CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
  WECHATPAY_SIGNATURE_HEADERS,
} from "@dshop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import app from "../src/index.js";
import { base64FromBytes } from "../src/routes/callbacks/crypto.js";
import { createSqliteD1 } from "./helpers/sqlite-d1.js";
import type { SqliteD1 } from "./helpers/sqlite-d1.js";

/* -------------------------------------------------------------------------- */
/* 固定数据                                                                     */
/* -------------------------------------------------------------------------- */

const JWT_SECRET = "callbacks-test-jwt-secret";
const WXPAY_V3_KEY = "0123456789abcdef0123456789abcdef"; // 32 字节
const ORDER_ID = "01J9Z8K2M4N5P6Q7R8S9T0O001";
const ORDER_NO = "DS20260920143000001";
const PAY_AMOUNT = 19900;
const NOW = "2026-09-20T06:30:00.000Z";

const WECHAT_PRIMARY = "/api/v1/callbacks/payment/wechat";
const WECHAT_ALIAS = "/api/v1/callbacks/wechat-pay";
const ALIPAY_PRIMARY = "/api/v1/callbacks/payment/alipay";
const ALIPAY_ALIAS = "/api/v1/callbacks/alipay";

/* -------------------------------------------------------------------------- */
/* WebCrypto 密钥与签名工具                                                      */
/* -------------------------------------------------------------------------- */

/** 生成的测试密钥对（PEM 公钥 + 用于签名的 `CryptoKey`）。 */
interface TestKeyPair {
  readonly publicKeyPem: string;
  readonly privateKey: CryptoKey;
}

/** 生成 RSA-2048 密钥对，并导出 `spki` PEM 公钥（`PUBLIC KEY` 形式）。 */
async function generateRsaKeyPair(): Promise<TestKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const body = base64FromBytes(new Uint8Array(spki as ArrayBuffer));
  const lines = body.match(/.{1,64}/gu) ?? [];
  return {
    publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`,
    privateKey: pair.privateKey,
  };
}

/** RSA-SHA256 签名 → 标准 base64。 */
async function signRsaSha256(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(message),
  );
  return base64FromBytes(new Uint8Array(signature));
}

/** `AEAD_AES_256_GCM` 加密（微信 v3 `resource` 的形状：密文 + tag 拼接后 base64）。 */
async function encryptWechatResource(
  apiV3Key: string,
  plaintext: string,
  nonce: string,
  associatedData: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiV3Key),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  // IV = `base64ToBytes(nonce)`（与生产 `decryptWechatResource()` 同口径）
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: base64Bytes(nonce),
      additionalData: new TextEncoder().encode(associatedData),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(plaintext),
  );
  return base64FromBytes(new Uint8Array(sealed));
}

/** base64（标准）→ 字节（测试侧与生产 `base64ToBytes` 同实现）。 */
function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/* -------------------------------------------------------------------------- */
/* 内存 D1 + Env                                                               */
/* -------------------------------------------------------------------------- */

let d1: SqliteD1;
let wechatKeys: TestKeyPair;
let alipayKeys: TestKeyPair;
/** 是否配置渠道公钥（用于「未配置」与「已配置」两条路径）。 */
let secretsConfigured: boolean;

function createEnv(): Env {
  const base: Env = {
    DB: d1.database,
    AGENT_TOKEN_PEPPER: "test-pepper",
    PHONE_ENC_KEY: "phone-enc-key",
    PHONE_HASH_PEPPER: "phone-hash-pepper",
    JWT_SECRET,
    ENVIRONMENT: "test",
  };
  if (!secretsConfigured) return base;

  /*
   * ⚠️ 渠道密钥绑定名**尚未登记进 `apps/api/src/env.ts`**（本任务不可改该文件）。
   * 生产读取走 `routes/callbacks/secrets.ts` 的结构化窄化，故这里用同一形状注入。
   */
  return {
    ...base,
    ...({
      WXPAY_PLATFORM_PUBLIC_KEY: wechatKeys.publicKeyPem,
      WXPAY_V3_KEY,
      ALIPAY_PUBLIC_KEY: alipayKeys.publicKeyPem,
      ALIPAY_APP_ID: "2021000000000000",
    } as Record<string, unknown>),
  } as Env;
}

/** 播种：一笔 `PENDING_PAYMENT` 主单 + 子单 + SKU（`stock=10`、`locked_stock=2`）。 */
function seed(): void {
  d1.run(
    `INSERT INTO product_skus
       (id, product_id, sku_code, spec, price, stock, locked_stock, status, created_at, updated_at)
     VALUES ('01J9Z8K2M4N5P6Q7R8S9T0KA01', '01J9Z8K2M4N5P6Q7R8S9T0PA01', 'SKU-1', '{}', ?, 10, 2, 'active', ?, ?)`,
    PAY_AMOUNT,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO orders
       (id, order_no, user_id, status, total_amount, discount_amount, freight_amount, pay_amount,
        address_snapshot, coupon_id, channel, pay_deadline, paid_at, completed_at, cancelled_at,
        remark, created_at, updated_at)
     VALUES (?, ?, '01J9Z8K2M4N5P6Q7R8S9T0Z001', 'PENDING_PAYMENT', ?, 0, 0, ?, '{}', NULL,
             'web', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ORDER_ID,
    ORDER_NO,
    PAY_AMOUNT,
    PAY_AMOUNT,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO sub_orders
       (id, sub_order_no, order_id, merchant_id, store_id, status, subtotal, discount_alloc,
        freight, commission_amount, settled, created_at, updated_at)
     VALUES ('01J9Z8K2M4N5P6Q7R8S9T0S001', ?, ?, '01J9Z8K2M4N5P6Q7R8S9T0MA01',
             '01J9Z8K2M4N5P6Q7R8S9T0SA01', 'PAID', ?, 0, 0, 0, 0, ?, ?)`,
    `${ORDER_NO}-01`,
    ORDER_ID,
    PAY_AMOUNT,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO order_items
       (id, sub_order_id, order_id, spu_id, sku_id, title, image, spec, unit_price, quantity, subtotal, created_at)
     VALUES ('01J9Z8K2M4N5P6Q7R8S9T0I001', '01J9Z8K2M4N5P6Q7R8S9T0S001', ?, '01J9Z8K2M4N5P6Q7R8S9T0PA01',
             '01J9Z8K2M4N5P6Q7R8S9T0KA01', '测试商品', NULL, '{}', ?, 2, ?, ?)`,
    ORDER_ID,
    PAY_AMOUNT / 2,
    PAY_AMOUNT,
    NOW,
  );
}

/* -------------------------------------------------------------------------- */
/* 请求辅助                                                                     */
/* -------------------------------------------------------------------------- */

interface CallOptions {
  readonly headers?: Record<string, string>;
  /** 原样发送的 body（微信 / 支付宝的**原始报文**，签名覆盖它）。 */
  readonly rawBody?: string;
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  return await app.request(
    path,
    {
      method: "POST",
      headers: { "X-Contract-Version": "1", ...(options.headers ?? {}) },
      body: options.rawBody,
    },
    createEnv(),
    executionCtx,
  );
}

interface Envelope {
  readonly code: unknown;
  readonly message: string;
  readonly data: unknown;
}

/** 构造一次**合法签名**的微信 v3 回调（含加密 `resource`）。 */
async function buildWechatCallback(input: {
  readonly transactionId: string;
  readonly outTradeNo?: string;
  readonly amountTotal?: number;
  readonly tradeState?: string;
  /** 覆盖时间戳（秒）；默认当前时刻。 */
  readonly timestamp?: number;
}): Promise<{ readonly body: string; readonly headers: Record<string, string> }> {
  // `resource.nonce` 同时是 GCM 的 IV，必须是**合法 base64**（12 字节）
  const nonce = base64FromBytes(new TextEncoder().encode("iv-12-bytes!"));
  const associatedData = "transaction";
  const resourcePlaintext = JSON.stringify({
    transaction_id: input.transactionId,
    out_trade_no: input.outTradeNo ?? ORDER_NO,
    trade_state: input.tradeState ?? "SUCCESS",
    amount: { total: input.amountTotal ?? PAY_AMOUNT, currency: "CNY" },
    success_time: NOW,
  });
  const ciphertext = await encryptWechatResource(
    WXPAY_V3_KEY,
    resourcePlaintext,
    nonce,
    associatedData,
  );

  const body = JSON.stringify({
    event_type: "TRANSACTION.SUCCESS",
    resource_type: "encrypt-resource",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      ciphertext,
      nonce,
      associated_data: associatedData,
    },
  });

  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const headerNonce = "nonce-1234567890";
  // 微信 v3 验签串：timestamp\nnonce\nbody\n（**尾部换行不可省**）
  const message = `${timestamp}\n${headerNonce}\n${body}\n`;
  const signature = await signRsaSha256(wechatKeys.privateKey, message);

  return {
    body,
    headers: {
      "Content-Type": "application/json",
      [WECHATPAY_SIGNATURE_HEADERS.TIMESTAMP]: timestamp,
      [WECHATPAY_SIGNATURE_HEADERS.NONCE]: headerNonce,
      [WECHATPAY_SIGNATURE_HEADERS.SIGNATURE]: signature,
      [WECHATPAY_SIGNATURE_HEADERS.SERIAL]: "TEST_SERIAL_0001",
    },
  };
}

/** 构造一次**合法签名**的支付宝异步通知（表单编码 + RSA2 签名）。 */
async function buildAlipayCallback(input: {
  readonly tradeNo: string;
  readonly outTradeNo?: string;
  readonly totalAmount?: string;
  readonly tradeStatus?: string;
}): Promise<string> {
  const fields: Record<string, string> = {
    notify_type: "trade_status_sync",
    out_trade_no: input.outTradeNo ?? ORDER_NO,
    trade_no: input.tradeNo,
    trade_status: input.tradeStatus ?? "TRADE_SUCCESS",
    total_amount: input.totalAmount ?? (PAY_AMOUNT / 100).toFixed(2),
    notify_time: "2026-09-20 14:31:22",
    app_id: "2021000000000000",
    sign_type: "RSA2",
  };
  // 待签串：除 `sign` / `sign_type` 外字段按键字典序拼 k=v&k=v
  // （与生产 `buildAlipaySignContent()` 同口径——`sign_type` 必须排除）
  const signContent = Object.keys(fields)
    .filter((key) => key !== "sign" && key !== "sign_type")
    .filter((key) => (fields[key] ?? "").length > 0)
    .sort()
    .map((key) => `${key}=${fields[key] ?? ""}`)
    .join("&");
  fields.sign = await signRsaSha256(alipayKeys.privateKey, signContent);

  return new URLSearchParams(fields).toString();
}

/* -------------------------------------------------------------------------- */
/* 生命周期                                                                     */
/* -------------------------------------------------------------------------- */

beforeEach(async () => {
  d1 = createSqliteD1();
  wechatKeys = await generateRsaKeyPair();
  alipayKeys = await generateRsaKeyPair();
  secretsConfigured = true;
  seed();
});

afterEach(() => {
  d1.close();
});

/* -------------------------------------------------------------------------- */
/* 1. 无鉴权（docs/06:14）                                                       */
/* -------------------------------------------------------------------------- */
describe("callbacks 组：无鉴权（docs/06:14「验签，无鉴权」）", () => {
  it("不带任何凭据时**不返回鉴权类错误码**（未挂 `requireAdminAuth`）", async () => {
    const res = await call(WECHAT_PRIMARY, { rawBody: "{}" });
    // 无验签头 → 401，但码必须是**验签**语义（不是 TOKEN_MISSING / TOKEN_INVALID）
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe(CALLBACK_ERROR_CODES.SIGNATURE_MISSING);
    expect(body.code).not.toBe(CALLBACK_ERROR_CODES.TOKEN_MISSING);
    expect(body.code).not.toBe(CALLBACK_ERROR_CODES.TOKEN_INVALID);
    expect(body.code).not.toBe(CALLBACK_ERROR_CODES.PERMISSION_DENIED);
  });

  it("错误码是字符串 ERR_CALLBACK_*（docs/README.md:34）", async () => {
    const res = await call(WECHAT_PRIMARY, { rawBody: "{}" });
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("string");
    expect(String(body.code).startsWith("ERR_CALLBACK_")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 微信验签失败路径                                                           */
/* -------------------------------------------------------------------------- */

describe("微信支付 v3：验签失败路径", () => {
  it("缺全部四个 Wechatpay-* 头 → 401 + ERR_CALLBACK_SIGNATURE_MISSING", async () => {
    const res = await call(WECHAT_PRIMARY, { rawBody: "{}" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.SIGNATURE_MISSING);
  });

  it("只缺 Wechatpay-Signature（其余三个头齐全）→ 同样是 SIGNATURE_MISSING", async () => {
    const built = await buildWechatCallback({ transactionId: "WX-TX-1" });
    const headers = { ...built.headers };
    delete headers[WECHATPAY_SIGNATURE_HEADERS.SIGNATURE];
    const res = await call(WECHAT_PRIMARY, { headers, rawBody: built.body });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.SIGNATURE_MISSING);
  });

  it("★ 时间戳超容忍窗口 → 401 + ERR_CALLBACK_TIMESTAMP_EXPIRED（视为重放）", async () => {
    const stale = Math.floor(Date.now() / 1000) - CALLBACK_TIMESTAMP_TOLERANCE_SECONDS - 60;
    const built = await buildWechatCallback({ transactionId: "WX-TX-2", timestamp: stale });
    const res = await call(WECHAT_PRIMARY, { headers: built.headers, rawBody: built.body });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.TIMESTAMP_EXPIRED);
  });

  it("时间戳在容差内（边界内 1 秒）→ 不放行时间戳检查", async () => {
    const nearEdge = Math.floor(Date.now() / 1000) - CALLBACK_TIMESTAMP_TOLERANCE_SECONDS + 5;
    const built = await buildWechatCallback({ transactionId: "WX-TX-3", timestamp: nearEdge });
    const res = await call(WECHAT_PRIMARY, { headers: built.headers, rawBody: built.body });
    expect(res.status).not.toBe(401);
  });

  it("时间戳非数字 → 401 + ERR_CALLBACK_SIGNATURE_INVALID", async () => {
    const built = await buildWechatCallback({ transactionId: "WX-TX-4" });
    const res = await call(WECHAT_PRIMARY, {
      headers: { ...built.headers, [WECHATPAY_SIGNATURE_HEADERS.TIMESTAMP]: "not-a-number" },
      rawBody: built.body,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.SIGNATURE_INVALID);
  });

  it("签名值被篡改 → 401 + ERR_CALLBACK_SIGNATURE_INVALID", async () => {
    const built = await buildWechatCallback({ transactionId: "WX-TX-5" });
    const res = await call(WECHAT_PRIMARY, {
      headers: { ...built.headers, [WECHATPAY_SIGNATURE_HEADERS.SIGNATURE]: "AAAA" },
      rawBody: built.body,
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.SIGNATURE_INVALID);
  });

  it("★ 未配置平台公钥 → ERR_CALLBACK_SIGNATURE_INVALID（安全侧默认：宁可拒真）", async () => {
    secretsConfigured = false;
    const built = await buildWechatCallback({ transactionId: "WX-TX-6" });
    const res = await call(WECHAT_PRIMARY, { headers: built.headers, rawBody: built.body });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe(CALLBACK_ERROR_CODES.SIGNATURE_INVALID);
    // 报错文案点明「需配置平台公钥」，便于部署排障
    expect(body.message).toContain("WXPAY_PLATFORM_PUBLIC_KEY");
  });

  it("验签通过但 WXPAY_V3_KEY 缺失 → ERR_CALLBACK_DECRYPT_FAILED", async () => {
    const built = await buildWechatCallback({ transactionId: "WX-TX-7" });
    // 仅去掉 APIv3 密钥（公钥保留，验签仍通过）
    const envWithoutV3Key = {
      ...createEnv(),
      ...({ WXPAY_V3_KEY: undefined } as Record<string, unknown>),
    } as Env;
    const executionCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const res = await app.request(
      WECHAT_PRIMARY,
      { method: "POST", headers: built.headers, body: built.body },
      envWithoutV3Key,
      executionCtx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.DECRYPT_FAILED);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 微信成功路径 + 幂等                                                         */
/* -------------------------------------------------------------------------- */

describe("★ 微信支付 v3：合法签名 → 成功且幂等（docs/08 §8.2）", () => {
  it('合法回调 → 200 + JSON `{ code: "SUCCESS" }`（渠道规定形状，非统一信封）', async () => {
    const built = await buildWechatCallback({ transactionId: "WX-TX-OK-1" });
    const res = await call(WECHAT_PRIMARY, { headers: built.headers, rawBody: built.body });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("SUCCESS");
    // ★ 负向控制：不是统一信封（无 `data` 字段）
    expect(body).not.toHaveProperty("data");
    expect(typeof body.message).toBe("string");
  });

  it("记账落库：payments 插入 1 行 + 主单转 PAID + 锁定转实扣", async () => {
    const built = await buildWechatCallback({ transactionId: "WX-TX-OK-2" });
    await call(WECHAT_PRIMARY, { headers: built.headers, rawBody: built.body });

    const payments = d1.query<{ pay_no: string; channel: string; status: string; amount: number }>(
      "SELECT pay_no, channel, status, amount FROM payments WHERE channel_trade_no = ?",
      "WX-TX-OK-2",
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]!.channel).toBe("wechat");
    expect(payments[0]!.status).toBe("PAID");
    expect(payments[0]!.amount).toBe(PAY_AMOUNT);

    const orders = d1.query<{ status: string; paid_at: string | null }>(
      "SELECT status, paid_at FROM orders WHERE id = ?",
      ORDER_ID,
    );
    expect(orders[0]!.status).toBe("PAID");
    expect(orders[0]!.paid_at).not.toBeNull();

    // 锁定转实扣：stock 10→8、locked_stock 2→0（数量 2，docs/05 §5.3①）
    const skus = d1.query<{ stock: number; locked_stock: number }>(
      "SELECT stock, locked_stock FROM product_skus WHERE id = '01J9Z8K2M4N5P6Q7R8S9T0KA01'",
    );
    expect(skus[0]!.stock).toBe(8);
    expect(skus[0]!.locked_stock).toBe(0);

    const logs = d1.query<{ from_status: string; to_status: string }>(
      "SELECT from_status, to_status FROM order_status_logs WHERE order_id = ?",
      ORDER_ID,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.from_status).toBe("PENDING_PAYMENT");
    expect(logs[0]!.to_status).toBe("PAID");
  });

  it("★ 幂等：同一 channel_trade_no 二次回调仍返回 SUCCESS，不重复记账 / 不重复扣库存", async () => {
    const first = await buildWechatCallback({ transactionId: "WX-TX-IDEM" });
    const res1 = await call(WECHAT_PRIMARY, { headers: first.headers, rawBody: first.body });
    expect(res1.status).toBe(200);
    expect(((await res1.json()) as { code: string }).code).toBe("SUCCESS");

    // 渠道重试：**同一流水号**的第二次回调
    const second = await buildWechatCallback({ transactionId: "WX-TX-IDEM" });
    const res2 = await call(WECHAT_PRIMARY, { headers: second.headers, rawBody: second.body });
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { code: string }).code).toBe("SUCCESS");

    // ★ 关键：只有 1 行 payments，库存只扣一次
    const payments = d1.query<{ id: string }>(
      "SELECT id FROM payments WHERE channel_trade_no = ?",
      "WX-TX-IDEM",
    );
    expect(payments).toHaveLength(1);

    const skus = d1.query<{ stock: number; locked_stock: number }>(
      "SELECT stock, locked_stock FROM product_skus WHERE id = '01J9Z8K2M4N5P6Q7R8S9T0KA01'",
    );
    expect(skus[0]!.stock).toBe(8);

    const logs = d1.query<{ id: string }>(
      "SELECT id FROM order_status_logs WHERE order_id = ?",
      ORDER_ID,
    );
    expect(logs).toHaveLength(1);
  });

  it("金额不一致 → 400 + ERR_CALLBACK_AMOUNT_MISMATCH（不记账）", async () => {
    const built = await buildWechatCallback({
      transactionId: "WX-TX-AMT",
      amountTotal: PAY_AMOUNT + 1,
    });
    const res = await call(WECHAT_PRIMARY, { headers: built.headers, rawBody: built.body });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.AMOUNT_MISMATCH);
    expect(
      d1.query("SELECT id FROM payments WHERE channel_trade_no = ?", "WX-TX-AMT"),
    ).toHaveLength(0);
  });

  it("订单不存在 → 404 + ERR_CALLBACK_NOT_FOUND", async () => {
    const built = await buildWechatCallback({
      transactionId: "WX-TX-NOORDER",
      outTradeNo: "DS20260920143099999",
    });
    const res = await call(WECHAT_PRIMARY, { headers: built.headers, rawBody: built.body });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.NOT_FOUND);
  });

  it("非 SUCCESS 交易状态 → 直接应答 SUCCESS（渠道停止重试），不记账", async () => {
    const built = await buildWechatCallback({
      transactionId: "WX-TX-REFUND",
      tradeState: "REFUND",
    });
    const res = await call(WECHAT_PRIMARY, { headers: built.headers, rawBody: built.body });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: string }).code).toBe("SUCCESS");
    expect(
      d1.query("SELECT id FROM payments WHERE channel_trade_no = ?", "WX-TX-REFUND"),
    ).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 支付宝                                                                     */
/* -------------------------------------------------------------------------- */

describe("★ 支付宝：纯文本应答（非 JSON）", () => {
  it("合法通知 → 200 + 纯文本 `success`（断言 content-type 与 body 形状）", async () => {
    const rawBody = await buildAlipayCallback({ tradeNo: "ALI-TX-OK-1" });
    const res = await call(ALIPAY_PRIMARY, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      rawBody,
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("Content-Type") ?? "";
    expect(contentType).toContain("text/plain");
    // ★ 负向控制：不是 JSON
    expect(contentType).not.toContain("json");

    const text = await res.text();
    expect(text).toBe("success");
    // 确保不是被 JSON 包了一层的 `"success"`
    expect(text.startsWith("{")).toBe(false);
  });

  it("记账落库（支付宝）", async () => {
    const rawBody = await buildAlipayCallback({ tradeNo: "ALI-TX-OK-2" });
    await call(ALIPAY_PRIMARY, { rawBody });

    const payments = d1.query<{ channel: string; status: string }>(
      "SELECT channel, status FROM payments WHERE channel_trade_no = ?",
      "ALI-TX-OK-2",
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]!.channel).toBe("alipay");
    expect(payments[0]!.status).toBe("PAID");
  });

  it("★ 幂等：同一 trade_no 二次通知仍返回 `success`，不重复记账", async () => {
    const first = await buildAlipayCallback({ tradeNo: "ALI-TX-IDEM" });
    const res1 = await call(ALIPAY_PRIMARY, { rawBody: first });
    expect(await res1.text()).toBe("success");

    const second = await buildAlipayCallback({ tradeNo: "ALI-TX-IDEM" });
    const res2 = await call(ALIPAY_PRIMARY, { rawBody: second });
    expect(res2.status).toBe(200);
    expect(await res2.text()).toBe("success");

    expect(
      d1.query("SELECT id FROM payments WHERE channel_trade_no = ?", "ALI-TX-IDEM"),
    ).toHaveLength(1);
  });

  it("签名被篡改 → 401 + ERR_CALLBACK_SIGNATURE_INVALID", async () => {
    const rawBody = await buildAlipayCallback({ tradeNo: "ALI-TX-BAD" });
    const tampered = rawBody.replace(/sign=[^&]+/u, "sign=AAAA");
    const res = await call(ALIPAY_PRIMARY, { rawBody: tampered });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.SIGNATURE_INVALID);
  });

  it("缺 `sign` 字段 → 400 + ERR_CALLBACK_INVALID_PARAM（契约要求 `sign` 必填）", async () => {
    const res = await call(ALIPAY_PRIMARY, {
      rawBody: "notify_type=trade_status_sync&out_trade_no=DS20260920143000001",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.INVALID_PARAM);
  });

  it("★ 未配置支付宝公钥 → ERR_CALLBACK_SIGNATURE_INVALID（安全侧默认）", async () => {
    secretsConfigured = false;
    const rawBody = await buildAlipayCallback({ tradeNo: "ALI-TX-NOKEY" });
    const res = await call(ALIPAY_PRIMARY, { rawBody });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe(CALLBACK_ERROR_CODES.SIGNATURE_INVALID);
    expect(body.message).toContain("ALIPAY_PUBLIC_KEY");
  });

  it("金额不一致 → 400 + ERR_CALLBACK_AMOUNT_MISMATCH", async () => {
    const rawBody = await buildAlipayCallback({
      tradeNo: "ALI-TX-AMT",
      totalAmount: "999.99",
    });
    const res = await call(ALIPAY_PRIMARY, { rawBody });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.AMOUNT_MISMATCH);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. 两套路径都可达（docs/06 别名）                                             */
/* -------------------------------------------------------------------------- */

describe("主路径与 docs/06 别名路径同时可用", () => {
  it("微信：`/payment/wechat` 与 `/wechat-pay` 命中同一 handler（各自独立幂等）", async () => {
    const primary = await buildWechatCallback({ transactionId: "WX-PRIMARY" });
    const resPrimary = await call(WECHAT_PRIMARY, {
      headers: primary.headers,
      rawBody: primary.body,
    });
    expect(resPrimary.status).toBe(200);
    expect(((await resPrimary.json()) as { code: string }).code).toBe("SUCCESS");

    const alias = await buildWechatCallback({ transactionId: "WX-ALIAS" });
    const resAlias = await call(WECHAT_ALIAS, { headers: alias.headers, rawBody: alias.body });
    expect(resAlias.status).toBe(200);
    expect(((await resAlias.json()) as { code: string }).code).toBe("SUCCESS");

    // 两笔都落了库（证明别名路径确实走到了同一 handler，而不是 404 被吞）
    expect(
      d1.query("SELECT id FROM payments WHERE channel_trade_no = ?", "WX-PRIMARY"),
    ).toHaveLength(1);
    expect(d1.query("SELECT id FROM payments WHERE channel_trade_no = ?", "WX-ALIAS")).toHaveLength(
      1,
    );
  });

  it("支付宝：`/payment/alipay` 与 `/alipay` 命中同一 handler", async () => {
    const primary = await buildAlipayCallback({ tradeNo: "ALI-PRIMARY" });
    const resPrimary = await call(ALIPAY_PRIMARY, { rawBody: primary });
    expect(await resPrimary.text()).toBe("success");

    const alias = await buildAlipayCallback({ tradeNo: "ALI-ALIAS" });
    const resAlias = await call(ALIPAY_ALIAS, { rawBody: alias });
    expect(await resAlias.text()).toBe("success");

    expect(
      d1.query("SELECT id FROM payments WHERE channel_trade_no = ?", "ALI-PRIMARY"),
    ).toHaveLength(1);
    expect(
      d1.query("SELECT id FROM payments WHERE channel_trade_no = ?", "ALI-ALIAS"),
    ).toHaveLength(1);
  });

  it("未登记的 callbacks 子路径 → 404 + ERR_CALLBACK_NOT_FOUND（字符串码）", async () => {
    const res = await call("/api/v1/callbacks/no-such-path", { rawBody: "{}" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Envelope).code).toBe(CALLBACK_ERROR_CODES.NOT_FOUND);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. 负向控制：callbacks 绝不返回 JWT / 服务令牌语义的错误码                      */
/* -------------------------------------------------------------------------- */

describe("负向控制：callbacks 无鉴权，不出现鉴权类错误码", () => {
  it("所有错误响应的码都来自 CALLBACK_ERROR_CODES（不是 ADMIN_/MERCHANT_）", async () => {
    const probes: readonly CallOptions[] = [
      { rawBody: "{}" },
      {
        headers: {
          [WECHATPAY_SIGNATURE_HEADERS.TIMESTAMP]: String(Math.floor(Date.now() / 1000)),
          [WECHATPAY_SIGNATURE_HEADERS.NONCE]: "n",
          [WECHATPAY_SIGNATURE_HEADERS.SIGNATURE]: "s",
          [WECHATPAY_SIGNATURE_HEADERS.SERIAL]: "1",
        },
        rawBody: "{}",
      },
    ];

    for (const options of probes) {
      const res = await call(WECHAT_PRIMARY, options);
      const body = (await res.json()) as Envelope;
      expect(String(body.code).startsWith("ERR_CALLBACK_")).toBe(true);
      // 负向：绝不返回商户 / 平台域的鉴权码
      expect(String(body.code)).not.toContain("ERR_ADMIN_");
      expect(String(body.code)).not.toContain("ERR_MERCHANT_");
      expect(String(body.code)).not.toContain("ERR_SHOP_");
    }
  });

  it("`aud` 常量存在性哨兵（避免本文件因未使用 import 被 tree-shake 掉语义）", () => {
    // `JWT_AUDIENCE` 是四套体系互不通用的定义来源（docs/09 §9.1）；
    // callbacks 组**不使用**任何 `aud`，这里仅断言常量本身可用。
    expect(JWT_AUDIENCE.SHOP).toBe("shop");
  });
});
