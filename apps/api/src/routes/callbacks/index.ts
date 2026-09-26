/**
 * 支付回调路由组（`/api/v1/callbacks/*`，`docs/06` §6 / `docs/08` §8.2）。
 *
 * ## 四条硬性约束（`packages/shared/src/contracts/callbacks.ts`）
 *
 * 1. **无鉴权**（`docs/06:14`：「支付/开放平台回调（验签，无鉴权）」）——
 *    本组**不挂** `requireAdminAuth` / `requirePermission`；安全完全依赖**验签**。
 * 2. **应答体是渠道规定形状**（**不是**统一信封）：
 *    - 微信支付 v3：`{ code: "SUCCESS", message: "" }`（`code` 为 `"SUCCESS"` 才算成功）
 *    - 支付宝：纯文本 `success` / `failure`
 *    - ⚠️ **错误响应仍走统一信封**（`backofficeErrorResponse` + `ERR_CALLBACK_*`）：
 *      任务要求「merchant/callbacks 组用字符串码」，且渠道对非 2xx / 非 SUCCESS 一律重试，
 *      故错误路径用带错误码的 JSON 便于排查。此定案已在汇报中登记。
 * 3. **幂等锚点是 `payments.channel_trade_no` 的唯一约束**（`docs/08` §8.2）：
 *    重复回调返回与首次**相同**的成功应答，**绝不重复记账 / 重复扣库存**。
 * 4. **时间戳容忍窗口** `CALLBACK_TIMESTAMP_TOLERANCE_SECONDS`（默认 300 秒），
 *    超出视为重放 → `ERR_CALLBACK_TIMESTAMP_EXPIRED`。
 *
 * ## 路径口径
 *
 * 主路径取 `CALLBACK_ENDPOINTS`（`/payment/wechat`、`/payment/alipay`）；
 * `docs/06` §6 的路由示例写作 `/wechat-pay`、`/alipay`，两者在
 * `CALLBACK_DOC_ALIAS_PATHS` 中并列登记——本实现**两套同时挂载**（同一 handler），
 * 由渠道配置决定实际使用哪一个。
 *
 * ## 挂载路径（供 `src/index.ts` 使用）
 *
 * ```ts
 * app.route("/api/v1/callbacks", callbackRoutes);
 * ```
 */

import {
  ALIPAY_FAILURE_TEXT,
  ALIPAY_SUCCESS_TEXT,
  CALLBACK_ERROR_CODES,
  CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
  PAYMENT_CHANNEL,
  WECHATPAY_SIGNATURE_HEADERS,
  WECHATPAY_SUCCESS_CODE,
  WechatPayCallbackBodySchema,
  WxpayTransactionResourceSchema,
  AlipayCallbackBodySchema,
} from "@dshop/shared";
import { Hono } from "hono";
import type { Context } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { backofficeErrorResponse } from "../../lib/errors.js";
import {
  applyPaymentSuccess,
  findOrderForCallback,
  TradeNoConflictError,
} from "../../repositories/merchant-callbacks.js";
import { buildAlipaySignContent, decryptWechatResource, verifyRsaSha256 } from "./crypto.js";
import { readCallbackSecrets } from "./secrets.js";

export const callbackRoutes = new Hono<AppEnv & { Bindings: Env }>();

/* -------------------------------------------------------------------------- */
/* 应答构造（渠道规范形状，**不是**统一信封）                                    */
/* -------------------------------------------------------------------------- */

/** 微信支付 v3 成功应答：`200` + `{ code: "SUCCESS", message: "" }`。 */
function wechatAck(): Response {
  return new Response(JSON.stringify({ code: WECHATPAY_SUCCESS_CODE, message: "" }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 支付宝异步通知成功应答：`200` + 纯文本 `success`。 */
function alipayAck(success: boolean): Response {
  return new Response(success ? ALIPAY_SUCCESS_TEXT : ALIPAY_FAILURE_TEXT, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/* -------------------------------------------------------------------------- */
/* 微信支付 v3                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 微信支付 v3 通知处理。
 *
 * 步骤（`docs/08` §8.2 + 微信 v3 规范）：
 * 1. 取四个 `Wechatpay-*` 头，缺失 → `ERR_CALLBACK_SIGNATURE_MISSING`
 * 2. 校验 `Wechatpay-Timestamp` 在容忍窗口内，否则 → `ERR_CALLBACK_TIMESTAMP_EXPIRED`
 * 3. 用平台公钥验证 `signature`（`timestamp\nnonce\nbody\n`，`SHA256withRSA`）；
 *    平台公钥**未配置**或验签不过 → `ERR_CALLBACK_SIGNATURE_INVALID`
 *    （**需配置平台公钥**：绑定名 `WXPAY_PLATFORM_PUBLIC_KEY`，见 `secrets.ts`）
 * 4. `AEAD_AES_256_GCM` 解密 `resource` → 失败 → `ERR_CALLBACK_DECRYPT_FAILED`
 * 5. 幂等记账（`channel_trade_no` 唯一约束）→ 成功应答
 */
async function handleWechatPayment(c: Context<AppEnv & { Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.text();
  const timestamp = c.req.header(WECHATPAY_SIGNATURE_HEADERS.TIMESTAMP);
  const nonce = c.req.header(WECHATPAY_SIGNATURE_HEADERS.NONCE);
  const signature = c.req.header(WECHATPAY_SIGNATURE_HEADERS.SIGNATURE);
  const serial = c.req.header(WECHATPAY_SIGNATURE_HEADERS.SERIAL);

  if (
    timestamp === undefined ||
    nonce === undefined ||
    signature === undefined ||
    serial === undefined
  ) {
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.SIGNATURE_MISSING,
      "缺少微信支付 v3 验签请求头",
    );
  }

  // 时间戳容差（`CALLBACK_TIMESTAMP_TOLERANCE_SECONDS`）：超出即视为重放
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.SIGNATURE_INVALID, "时间戳不是数字");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > CALLBACK_TIMESTAMP_TOLERANCE_SECONDS) {
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.TIMESTAMP_EXPIRED,
      "回调时间戳超出容忍窗口",
    );
  }

  const secrets = readCallbackSecrets(c.env);
  if (secrets.wechatPlatformPublicKey === null) {
    /*
     * ⚠️ **需配置平台公钥**（绑定名 `WXPAY_PLATFORM_PUBLIC_KEY`，见 `secrets.ts`）。
     * 未配置时一律拒绝——**安全侧默认**：宁可拒真，不可收假。
     */
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.SIGNATURE_INVALID,
      "未配置微信支付平台公钥（WXPAY_PLATFORM_PUBLIC_KEY），无法验签",
    );
  }

  // 微信 v3 验签串：timestamp\nnonce\nbody\n（**尾部换行不可省**）
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const verified = await verifyRsaSha256(secrets.wechatPlatformPublicKey, message, signature);
  if (!verified) {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.SIGNATURE_INVALID, "微信支付验签失败");
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawBody);
  } catch {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.INVALID_PARAM, "回调报文不是合法 JSON");
  }
  const parsedBody = WechatPayCallbackBodySchema.safeParse(rawJson);
  if (!parsedBody.success) {
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.INVALID_PARAM,
      parsedBody.error.issues[0]?.message ?? "回调报文不合法",
    );
  }
  const body = parsedBody.data;

  const plaintext = await decryptWechatResource({
    apiV3Key: secrets.wechatApiV3Key,
    nonce: body.resource.nonce,
    associatedData: body.resource.associated_data,
    ciphertext: body.resource.ciphertext,
  });
  if (plaintext === null) {
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.DECRYPT_FAILED,
      "回调资源解密失败（需配置 WXPAY_V3_KEY 且为 32 字节）",
    );
  }

  let resourceJson: unknown;
  try {
    resourceJson = JSON.parse(plaintext);
  } catch {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.DECRYPT_FAILED, "解密结果不是合法 JSON");
  }
  const parsedResource = WxpayTransactionResourceSchema.safeParse(resourceJson);
  if (!parsedResource.success) {
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.INVALID_PARAM,
      parsedResource.error.issues[0]?.message ?? "解密后的支付结果字段不合法",
    );
  }
  const resource = parsedResource.data;

  // 非「支付成功」事件（如退款通知）不需要记账，直接应答成功让渠道停止重试
  if (resource.trade_state !== "SUCCESS") return wechatAck();

  const order = await findOrderForCallback(c.env.DB, resource.out_trade_no);
  if (order === null) {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.NOT_FOUND, "回调指向的订单不存在");
  }
  // 金额口径：微信 `amount.total` 已是「分」，与 `orders.pay_amount` 同口径
  if (resource.amount.total !== order.pay_amount) {
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.AMOUNT_MISMATCH,
      "回调金额与订单金额不一致",
    );
  }

  const nowIso = new Date().toISOString();
  try {
    await applyPaymentSuccess(c.env.DB, {
      orderId: order.id,
      channel: PAYMENT_CHANNEL.WECHAT,
      channelTradeNo: resource.transaction_id,
      amount: resource.amount.total,
      paidAt: resource.success_time,
      rawCallback: plaintext,
      nowIso,
    });
  } catch (error) {
    if (error instanceof TradeNoConflictError) {
      return backofficeErrorResponse(
        CALLBACK_ERROR_CODES.TRADE_NO_CONFLICT,
        "渠道交易号已被另一订单占用",
      );
    }
    throw error;
  }

  // 首次与重复回调返回**同一**成功应答（幂等，`docs/08` §8.2）
  return wechatAck();
}

/* -------------------------------------------------------------------------- */
/* 支付宝                                                                       */
/* -------------------------------------------------------------------------- */

/** 解析支付宝通知体：优先 JSON，回退 `application/x-www-form-urlencoded`。 */
function parseAlipayBody(rawBody: string): Record<string, string> | null {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null) return null;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return null;
    }
  }
  // 支付宝真实通知为表单编码（`a=1&b=2`）
  const params = new URLSearchParams(trimmed);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return Object.keys(out).length > 0 ? out : null;
}

/** 支付宝 `yyyy-MM-dd HH:mm:ss`（UTC+8）→ UTC ISO-8601；非法返回 `null`。 */
function alipayTimeToIso(raw: string): string | null {
  const parsed = new Date(raw.replace(" ", "T") + "+08:00");
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** 元（两位小数字符串）→ 分（整数）；非法返回 `null`。 */
function yuanToCents(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * 支付宝异步通知处理。
 *
 * 步骤：
 * 1. 解析报文（JSON 或表单编码），字段不合法 → `ERR_CALLBACK_INVALID_PARAM`
 * 2. 缺 `sign` → `ERR_CALLBACK_SIGNATURE_MISSING`
 * 3. 用支付宝公钥验证 `sign`（除 `sign` / `sign_type` 外字段按字典序拼 `k=v&k=v`）；
 *    公钥**未配置**或验签不过 → `ERR_CALLBACK_SIGNATURE_INVALID`
 * 4. `TRADE_SUCCESS` / `TRADE_FINISHED` 才记账，其余直接应答 `success`
 * 5. 幂等记账 → 纯文本 `success`
 */
async function handleAlipayPayment(c: Context<AppEnv & { Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.text();
  const fields = parseAlipayBody(rawBody);
  if (fields === null) {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.INVALID_PARAM, "回调报文不合法");
  }

  const parsed = AlipayCallbackBodySchema.safeParse(fields);
  if (!parsed.success) {
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.INVALID_PARAM,
      parsed.error.issues[0]?.message ?? "回调报文不合法",
    );
  }
  const body = parsed.data;

  const secrets = readCallbackSecrets(c.env);
  if (secrets.alipayPublicKey === null) {
    // ⚠️ **需配置支付宝公钥**（绑定名 `ALIPAY_PUBLIC_KEY`，见 `secrets.ts`）
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.SIGNATURE_INVALID,
      "未配置支付宝公钥（ALIPAY_PUBLIC_KEY），无法验签",
    );
  }

  // 通知归属校验（配置了 `ALIPAY_APP_ID` 才校验）
  if (secrets.alipayAppId !== null && body.app_id !== secrets.alipayAppId) {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.SIGNATURE_INVALID, "通知不属于本应用");
  }

  const signContent = buildAlipaySignContent(fields);
  const verified = await verifyRsaSha256(secrets.alipayPublicKey, signContent, body.sign);
  if (!verified) {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.SIGNATURE_INVALID, "支付宝验签失败");
  }

  // 仅支付成功状态需要记账
  if (body.trade_status !== "TRADE_SUCCESS" && body.trade_status !== "TRADE_FINISHED") {
    return alipayAck(true);
  }

  const amountCents = yuanToCents(body.total_amount);
  if (amountCents === null) {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.INVALID_PARAM, "total_amount 不是合法金额");
  }
  const paidAt = alipayTimeToIso(body.notify_time);
  if (paidAt === null) {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.INVALID_PARAM, "notify_time 格式非法");
  }

  const order = await findOrderForCallback(c.env.DB, body.out_trade_no);
  if (order === null) {
    return backofficeErrorResponse(CALLBACK_ERROR_CODES.NOT_FOUND, "回调指向的订单不存在");
  }
  if (amountCents !== order.pay_amount) {
    return backofficeErrorResponse(
      CALLBACK_ERROR_CODES.AMOUNT_MISMATCH,
      "回调金额与订单金额不一致",
    );
  }

  const nowIso = new Date().toISOString();
  try {
    await applyPaymentSuccess(c.env.DB, {
      orderId: order.id,
      channel: PAYMENT_CHANNEL.ALIPAY,
      channelTradeNo: body.trade_no,
      amount: amountCents,
      paidAt,
      rawCallback: JSON.stringify(fields),
      nowIso,
    });
  } catch (error) {
    if (error instanceof TradeNoConflictError) {
      return backofficeErrorResponse(
        CALLBACK_ERROR_CODES.TRADE_NO_CONFLICT,
        "渠道交易号已被另一订单占用",
      );
    }
    throw error;
  }

  return alipayAck(true);
}

/* -------------------------------------------------------------------------- */
/* 路由注册（主路径 + `docs/06` 别名，同一 handler）                             */
/* -------------------------------------------------------------------------- */

/** 主路径：`CALLBACK_ENDPOINTS.WECHAT_PAYMENT.path`（去掉 `/callbacks` 前缀）。 */
callbackRoutes.post("/payment/wechat", handleWechatPayment);
/** 主路径：`CALLBACK_ENDPOINTS.ALIPAY_PAYMENT.path`（去掉 `/callbacks` 前缀）。 */
callbackRoutes.post("/payment/alipay", handleAlipayPayment);

/*
 * `docs/06` §6 的别名路径（`CALLBACK_DOC_ALIAS_PATHS`）：
 * `/api/v1/callbacks/wechat-pay`、`/api/v1/callbacks/alipay`。
 * 一期二者并存，由渠道配置决定实际使用哪一个。
 */
callbackRoutes.post("/wechat-pay", handleWechatPayment);
callbackRoutes.post("/alipay", handleAlipayPayment);

/** 已登记的回调路径（相对 `/api/v1/callbacks`；契约测试用）。 */
export const REGISTERED_CALLBACK_PATHS: readonly string[] = [
  "/payment/wechat",
  "/payment/alipay",
  "/wechat-pay",
  "/alipay",
];
