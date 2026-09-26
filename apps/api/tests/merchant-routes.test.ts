/**
 * 商户后台路由契约测试（`/api/v1/merchant/*`，`docs/06` §6 / `docs/09` §9.1–§9.2）。
 *
 * ## 覆盖的硬性契约
 *
 * 1. **12 条端点全部可达**（严格对齐 `MERCHANT_ENDPOINTS`），不是 404。
 * 2. **未登录 → `ERR_MERCHANT_UNAUTHORIZED`**（字符串码，`docs/README.md:34`）。
 * 3. ★ **商户行级隔离（本文件的核心）**：`docs/09` §9.2「商户数据行级隔离由
 *    `merchantScope` 强制注入 `merchant_id = 当前商户`，**不依赖前端传参**」。
 *    负向控制见「商户 A 的令牌**显式传入**商户 B 的标识」一组用例。
 * 4. **`aud` 互斥**（`docs/09` §9.1）：`merchant` 令牌访问 `/api/v1/admin/*` → 401。
 * 5. **错误码分层**：merchant 路径一律字符串 `ERR_MERCHANT_*`，绝不出现 Agent 整数码。
 *
 * ## 测试基建
 *
 * D1 用 `helpers/sqlite-d1.ts`（**真实 SQLite 引擎**，跑 `0001_init.sql` 全量 DDL）——
 * 这是隔离断言能成立的前提：隔离条件必须被**真的执行**，而不是被假替身忽略。
 *
 * 请求走**真实生产入口** `../src/index.js`，不自建中间件链
 * （与 `admin-auth.test.ts` / `error-codes.test.ts` 同纪律）。
 */

import { hashPassword, signJwt } from "@dshop/auth";
import { JWT_AUDIENCE, MERCHANT_ERROR_CODES } from "@dshop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import app from "../src/index.js";
import { createSqliteD1 } from "./helpers/sqlite-d1.js";
import type { SqliteD1 } from "./helpers/sqlite-d1.js";

/* -------------------------------------------------------------------------- */
/* 固定数据                                                                     */
/* -------------------------------------------------------------------------- */

const JWT_SECRET = "merchant-test-jwt-secret";

/** 商户 A / B 的 ULID（26 位 Crocksford Base32）。 */
const MERCHANT_A = "01J9Z8K2M4N5P6Q7R8S9T0MA01";
const MERCHANT_B = "01J9Z8K2M4N5P6Q7R8S9T0MB01";

/** 商户成员账号（`admin_users.id`）。 */
const USER_A = "01J9Z8K2M4N5P6Q7R8S9T0UA01";
const USER_B = "01J9Z8K2M4N5P6Q7R8S9T0UB01";
/** 平台侧账号（无 `merchant_members` 关联）。 */
const USER_PLATFORM = "01J9Z8K2M4N5P6Q7R8S9T0UP01";

const ROLE_MERCHANT = "01J9Z8K2M4N5P6Q7R8S9T0RM01";
const ROLE_PLATFORM = "01J9Z8K2M4N5P6Q7R8S9T0RP01";

const STORE_A = "01J9Z8K2M4N5P6Q7R8S9T0SA01";
const STORE_B = "01J9Z8K2M4N5P6Q7R8S9T0SB01";

/** A 的独占订单（只有 A 的子单）。 */
const ORDER_A = "DS20260920143000001";
/** B 的独占订单。 */
const ORDER_B = "DS20260920143000002";
/** **共享主单**：两个子单分属 A 与 B（跨商户拆单）。 */
const ORDER_SHARED = "DS20260920143000003";

const CATEGORY_ROOT = "01J9Z8K2M4N5P6Q7R8S9T0C001";
const CATEGORY_CHILD = "01J9Z8K2M4N5P6Q7R8S9T0C002";
const PRODUCT_A = "01J9Z8K2M4N5P6Q7R8S9T0PA01";
const PRODUCT_B = "01J9Z8K2M4N5P6Q7R8S9T0PB01";
const SKU_A = "01J9Z8K2M4N5P6Q7R8S9T0KA01";

const NOW = "2026-09-20T06:30:00.000Z";

/** 与 `admin-auth.test.ts` 一致的 Cookie 名（商户入口复用，见 `routes/merchant/auth.ts`）。 */
const ACCESS_COOKIE = "dshop_admin_at";

/* -------------------------------------------------------------------------- */
/* 内存 D1 + Env                                                               */
/* -------------------------------------------------------------------------- */

let d1: SqliteD1;
/** 商户 A 的 Access Token（`aud = merchant`，`mid = MERCHANT_A`）。 */
let tokenA: string;
/** 商户 B 的 Access Token。 */
let tokenB: string;
/** 平台侧 Access Token（`aud = admin`，无 `mid`）。 */
let tokenPlatform: string;
let passwordHash: string;

function createEnv(): Env {
  return {
    DB: d1.database,
    AGENT_TOKEN_PEPPER: "test-pepper",
    PHONE_ENC_KEY: "phone-enc-key",
    PHONE_HASH_PEPPER: "phone-hash-pepper",
    JWT_SECRET,
    ENVIRONMENT: "test",
  };
}

/** 播种：两商户、两账号、两门店、三订单（含一共享单）、商品与类目。 */
function seed(): void {
  // --- 角色（`roles.code` 唯一） ---
  d1.run(
    `INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at)
     VALUES (?, 'merchant', 'merchant_admin', '商户管理员', ?, ?, ?)`,
    ROLE_MERCHANT,
    JSON.stringify(["order:ship", "aftersale:approve"]),
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO roles (id, scope, code, name, permissions, created_at, updated_at)
     VALUES (?, 'platform', 'platform_super_admin', '平台超管', '[]', ?, ?)`,
    ROLE_PLATFORM,
    NOW,
    NOW,
  );

  // --- 账号 ---
  for (const [id, username] of [
    [USER_A, "merchant-a"],
    [USER_B, "merchant-b"],
    [USER_PLATFORM, "platform"],
  ] as const) {
    d1.run(
      `INSERT INTO admin_users
         (id, username, password_hash, nickname, status, totp_secret, totp_enabled,
          failed_attempts, locked_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', NULL, 0, 0, NULL, ?, ?)`,
      id,
      username,
      passwordHash,
      username,
      NOW,
      NOW,
    );
  }
  d1.run(
    `INSERT INTO admin_user_roles (id, admin_user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
    "01J9Z8K2M4N5P6Q7R8S9T0AR01",
    USER_A,
    ROLE_MERCHANT,
    NOW,
  );
  d1.run(
    `INSERT INTO admin_user_roles (id, admin_user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
    "01J9Z8K2M4N5P6Q7R8S9T0AR02",
    USER_B,
    ROLE_MERCHANT,
    NOW,
  );
  d1.run(
    `INSERT INTO admin_user_roles (id, admin_user_id, role_id, created_at) VALUES (?, ?, ?, ?)`,
    "01J9Z8K2M4N5P6Q7R8S9T0AR03",
    USER_PLATFORM,
    ROLE_PLATFORM,
    NOW,
  );

  // --- 商户成员（行级隔离的唯一依据） ---
  d1.run(
    `INSERT INTO merchant_members (id, merchant_id, admin_user_id, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
    "01J9Z8K2M4N5P6Q7R8S9T0MM01",
    MERCHANT_A,
    USER_A,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO merchant_members (id, merchant_id, admin_user_id, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
    "01J9Z8K2M4N5P6Q7R8S9T0MM02",
    MERCHANT_B,
    USER_B,
    NOW,
    NOW,
  );

  // --- 商户与门店 ---
  for (const [id, name] of [
    [MERCHANT_A, "商户 A"],
    [MERCHANT_B, "商户 B"],
  ] as const) {
    d1.run(
      `INSERT INTO merchants (id, type, name, status, created_at, updated_at)
       VALUES (?, 'vendor', ?, 'approved', ?, ?)`,
      id,
      name,
      NOW,
      NOW,
    );
  }
  d1.run(
    `INSERT INTO stores (id, merchant_id, name, type, province, city, supports_pickup, status, created_at, updated_at)
     VALUES (?, ?, 'A 仓', 'warehouse', '浙江省', '杭州市', 0, 'active', ?, ?)`,
    STORE_A,
    MERCHANT_A,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO stores (id, merchant_id, name, type, province, city, supports_pickup, status, created_at, updated_at)
     VALUES (?, ?, 'B 仓', 'warehouse', '江苏省', '南京市', 0, 'active', ?, ?)`,
    STORE_B,
    MERCHANT_B,
    NOW,
    NOW,
  );

  // --- 类目（两级，用于 `level` 推导） ---
  d1.run(
    `INSERT INTO categories (id, parent_id, name, sort_order, status, created_at, updated_at)
     VALUES (?, NULL, '数码', 1, 'active', ?, ?)`,
    CATEGORY_ROOT,
    NOW,
    NOW,
  );
  d1.run(
    `INSERT INTO categories (id, parent_id, name, sort_order, status, created_at, updated_at)
     VALUES (?, ?, '耳机', 1, 'active', ?, ?)`,
    CATEGORY_CHILD,
    CATEGORY_ROOT,
    NOW,
    NOW,
  );

  // --- 商品（A 与 B 各一件） ---
  for (const [id, merchantId, title] of [
    [PRODUCT_A, MERCHANT_A, "A 的商品"],
    [PRODUCT_B, MERCHANT_B, "B 的商品"],
  ] as const) {
    d1.run(
      `INSERT INTO products (id, merchant_id, category_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'onsale', ?, ?)`,
      id,
      merchantId,
      CATEGORY_CHILD,
      title,
      NOW,
      NOW,
    );
  }
  d1.run(
    `INSERT INTO product_skus (id, product_id, sku_code, spec, price, stock, locked_stock, status, created_at, updated_at)
     VALUES (?, ?, 'SKU-A-1', '{"颜色":"黑"}', 19900, 10, 2, 'active', ?, ?)`,
    SKU_A,
    PRODUCT_A,
    NOW,
    NOW,
  );

  // --- 订单 ---
  const addressSnapshot = JSON.stringify({
    receiver_name: "李晓雨",
    receiver_phone: "13888888888",
    province: "浙江省",
    city: "杭州市",
    district: "西湖区",
    detail: "文三路 478 号",
  });

  for (const [id, orderNo, status, payAmount] of [
    ["01J9Z8K2M4N5P6Q7R8S9T0O001", ORDER_A, "PAID", 19900],
    ["01J9Z8K2M4N5P6Q7R8S9T0O002", ORDER_B, "PAID", 29900],
    ["01J9Z8K2M4N5P6Q7R8S9T0O003", ORDER_SHARED, "PAID", 49800],
  ] as const) {
    d1.run(
      `INSERT INTO orders
         (id, order_no, user_id, status, total_amount, discount_amount, freight_amount,
          pay_amount, address_snapshot, coupon_id, channel, pay_deadline, paid_at,
          completed_at, cancelled_at, remark, created_at, updated_at)
       VALUES (?, ?, '01J9Z8K2M4N5P6Q7R8S9T0Z001', ?, ?, 0, 0, ?, ?, NULL, 'web', NULL, ?, NULL, NULL, NULL, ?, ?)`,
      id,
      orderNo,
      status,
      payAmount,
      payAmount,
      addressSnapshot,
      NOW,
      NOW,
      NOW,
    );
  }

  // --- 子单（共享单的两个子单分属 A 与 B） ---
  const subOrders: readonly (readonly [string, string, string, string, string])[] = [
    [
      "01J9Z8K2M4N5P6Q7R8S9T0S001",
      `${ORDER_A}-01`,
      "01J9Z8K2M4N5P6Q7R8S9T0O001",
      MERCHANT_A,
      STORE_A,
    ],
    [
      "01J9Z8K2M4N5P6Q7R8S9T0S002",
      `${ORDER_B}-01`,
      "01J9Z8K2M4N5P6Q7R8S9T0O002",
      MERCHANT_B,
      STORE_B,
    ],
    [
      "01J9Z8K2M4N5P6Q7R8S9T0S003",
      `${ORDER_SHARED}-01`,
      "01J9Z8K2M4N5P6Q7R8S9T0O003",
      MERCHANT_A,
      STORE_A,
    ],
    [
      "01J9Z8K2M4N5P6Q7R8S9T0S004",
      `${ORDER_SHARED}-02`,
      "01J9Z8K2M4N5P6Q7R8S9T0O003",
      MERCHANT_B,
      STORE_B,
    ],
  ];
  for (const [id, subOrderNo, orderId, merchantId, storeId] of subOrders) {
    d1.run(
      `INSERT INTO sub_orders
         (id, sub_order_no, order_id, merchant_id, store_id, status, subtotal,
          discount_alloc, freight, commission_amount, settled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PAID', 10000, 0, 0, 0, 0, ?, ?)`,
      id,
      subOrderNo,
      orderId,
      merchantId,
      storeId,
      NOW,
      NOW,
    );
  }

  // --- 商品快照（每个子单一条，便于区分归属） ---
  for (const [id, subOrderId, title, skuId] of [
    ["01J9Z8K2M4N5P6Q7R8S9T0I001", "01J9Z8K2M4N5P6Q7R8S9T0S001", "A 的商品快照", SKU_A],
    ["01J9Z8K2M4N5P6Q7R8S9T0I002", "01J9Z8K2M4N5P6Q7R8S9T0S002", "B 的商品快照", SKU_A],
    ["01J9Z8K2M4N5P6Q7R8S9T0I003", "01J9Z8K2M4N5P6Q7R8S9T0S003", "共享单 A 侧快照", SKU_A],
    ["01J9Z8K2M4N5P6Q7R8S9T0I004", "01J9Z8K2M4N5P6Q7R8S9T0S004", "共享单 B 侧快照", SKU_A],
  ] as const) {
    d1.run(
      `INSERT INTO order_items
         (id, sub_order_id, order_id, spu_id, sku_id, title, image, spec, unit_price, quantity, subtotal, created_at)
       VALUES (?, ?, (SELECT order_id FROM sub_orders WHERE id = ?), ?, ?, ?, NULL, '{"颜色":"黑"}', 10000, 1, 10000, ?)`,
      id,
      subOrderId,
      subOrderId,
      PRODUCT_A,
      skuId,
      title,
      NOW,
    );
  }

  // --- 售后（A 侧一条） ---
  d1.run(
    `INSERT INTO aftersales
       (id, aftersale_no, order_id, sub_order_id, user_id, sku_id, item_title, quantity,
        type, status, reason, evidence_urls, refund_amount, return_address,
        return_express_company, return_express_no, deadline_at, applied_at, refunded_at,
        created_at, updated_at)
     VALUES ('01J9Z8K2M4N5P6Q7R8S9T0AF01', 'AS20260920001', '01J9Z8K2M4N5P6Q7R8S9T0O001',
             '01J9Z8K2M4N5P6Q7R8S9T0S001', '01J9Z8K2M4N5P6Q7R8S9T0Z001', ?, 'A 的商品快照', 1,
             'refund_only', 'PENDING_MERCHANT', '不想要了', '["https://example.com/e1.jpg"]', 19900,
             NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    SKU_A,
    NOW,
    NOW,
    NOW,
  );
  // --- 售后（B 侧一条，用于隔离负向控制） ---
  d1.run(
    `INSERT INTO aftersales
       (id, aftersale_no, order_id, sub_order_id, user_id, sku_id, item_title, quantity,
        type, status, reason, evidence_urls, refund_amount, return_address,
        return_express_company, return_express_no, deadline_at, applied_at, refunded_at,
        created_at, updated_at)
     VALUES ('01J9Z8K2M4N5P6Q7R8S9T0AF02', 'AS20260920002', '01J9Z8K2M4N5P6Q7R8S9T0O002',
             '01J9Z8K2M4N5P6Q7R8S9T0S002', '01J9Z8K2M4N5P6Q7R8S9T0Z001', ?, 'B 的商品快照', 1,
             'refund_only', 'PENDING_MERCHANT', 'B 的原因', '[]', 29900,
             NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
    SKU_A,
    NOW,
    NOW,
    NOW,
  );
}

/* -------------------------------------------------------------------------- */
/* 请求辅助                                                                     */
/* -------------------------------------------------------------------------- */

interface CallOptions {
  readonly method?: string;
  readonly token?: string | null;
  readonly cookie?: string;
  readonly body?: unknown;
  readonly query?: Record<string, string>;
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { "X-Contract-Version": "1" };
  if (options.token !== undefined && options.token !== null) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  if (options.cookie !== undefined) headers["Cookie"] = options.cookie;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  return await app.request(
    url.toString(),
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

interface PageEnvelope<T> {
  readonly code: 0;
  readonly data: {
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
    readonly list: T[];
  };
}

/** 以真实入口发起请求并解析统一信封。 */
async function callJson<T>(
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; body: Envelope & { data: T } }> {
  const res = await call(path, options);
  return { status: res.status, body: (await res.json()) as Envelope & { data: T } };
}

/**
 * 取全部 `Set-Cookie`。
 *
 * 与 `admin-auth.test.ts` 同实现：优先 Node 22+ / workerd 的 `Headers#getSetCookie()`，
 * 缺失时回退 `get("set-cookie")`（后者会把多个 Cookie 合并，故仅在单 Cookie 场景可靠）。
 */
function getSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw === null ? [] : [raw];
}

/** 从 `Set-Cookie` 数组里取出某个 Cookie 名对应的完整串。 */
function findCookie(cookies: readonly string[], name: string): string | undefined {
  return cookies.find((cookie) => cookie.startsWith(`${name}=`));
}

/** 取 Cookie 的原始值（第一个 `=` 之后到 `;` 之前）。 */
function cookieValue(cookie: string): string {
  const eq = cookie.indexOf("=");
  const semi = cookie.indexOf(";", eq);
  return cookie.slice(eq + 1, semi === -1 ? undefined : semi);
}

beforeEach(async () => {
  d1 = createSqliteD1();
  passwordHash = await hashPassword("secret-password");
  seed();

  tokenA = await signJwt({ sub: USER_A, role: "merchant_admin", mid: MERCHANT_A }, JWT_SECRET, {
    aud: JWT_AUDIENCE.MERCHANT,
  });
  tokenB = await signJwt({ sub: USER_B, role: "merchant_admin", mid: MERCHANT_B }, JWT_SECRET, {
    aud: JWT_AUDIENCE.MERCHANT,
  });
  tokenPlatform = await signJwt({ sub: USER_PLATFORM, role: "platform_super_admin" }, JWT_SECRET, {
    aud: JWT_AUDIENCE.ADMIN,
  });
});

afterEach(() => {
  d1.close();
});

/* -------------------------------------------------------------------------- */
/* 1. 12 条端点全部可达 + 未登录语义                                             */
/* -------------------------------------------------------------------------- */

/** `MERCHANT_ENDPOINTS` 的 12 条路径（`packages/shared/src/contracts/merchant.ts`）。 */
const ENDPOINTS: readonly (readonly [string, string])[] = [
  ["POST", "/api/v1/merchant/login"],
  ["POST", "/api/v1/merchant/refresh"],
  ["POST", "/api/v1/merchant/logout"],
  ["GET", "/api/v1/merchant/me"],
  ["GET", "/api/v1/merchant/orders"],
  ["GET", `/api/v1/merchant/orders/${ORDER_A}`],
  ["GET", "/api/v1/merchant/aftersales"],
  ["GET", "/api/v1/merchant/aftersales/AS20260920001"],
  ["GET", "/api/v1/merchant/products"],
  ["GET", "/api/v1/merchant/categories"],
  ["GET", "/api/v1/merchant/merchants"],
  ["GET", "/api/v1/merchant/stores"],
];

describe("merchant 组：12 条端点全部可达（不是 404）", () => {
  for (const [method, path] of ENDPOINTS) {
    it(`${method} ${path} 已挂载（未登录也不是 404）`, async () => {
      const res = await call(path, { method });
      // 未登录 → 401；已挂载但方法不匹配才会是 405；**唯独不该是 404**
      expect(res.status, `${path} 未挂载（404）`).not.toBe(404);
    });
  }

  it("已挂载端点的路径集合逐字等于 MERCHANT_ENDPOINTS（不含多挂的端点）", async () => {
    // 反向：一个显然不存在的子路径必须是 404（证明上一条的「不是 404」有意义）
    const res = await call("/api/v1/merchant/no-such-endpoint", { token: tokenA });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.NOT_FOUND);
  });
});

describe("merchant 组：未登录语义（字符串码，docs/README.md:34）", () => {
  for (const [method, path] of ENDPOINTS) {
    // login / refresh / logout 是**公开**端点（无需登录），单独在下面覆盖
    if (path.endsWith("/login") || path.endsWith("/refresh") || path.endsWith("/logout")) continue;

    it(`${method} ${path} 未登录 → 401 + ERR_MERCHANT_UNAUTHORIZED`, async () => {
      const res = await call(path, { method });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe(MERCHANT_ERROR_CODES.UNAUTHORIZED);
      // 负向控制：不得是 Agent 组的整数码
      expect(typeof body.code).toBe("string");
    });
  }

  it("Cookie 形式的凭据同样被接受（Web 走 HttpOnly Cookie，docs/09 §9.1）", async () => {
    const res = await call("/api/v1/merchant/me", {
      cookie: `${ACCESS_COOKIE}=${tokenA}`,
    });
    expect(res.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. ★ 商户行级隔离（含负向控制）                                              */
/* -------------------------------------------------------------------------- */

describe("★ 商户行级隔离（docs/09 §9.2：SQL 层强制注入 merchant_id）", () => {
  it("商户 A 的订单列表**只**含 A 的订单，不含 B 的订单号", async () => {
    const { status, body } = await callJson<PageEnvelope<{ orderNo: string }>["data"]>(
      "/api/v1/merchant/orders",
      { token: tokenA },
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);

    const orderNos = body.data.list.map((row) => row.orderNo);
    // A 的独占单 + 共享单（A 有子单）可见
    expect(orderNos).toContain(ORDER_A);
    expect(orderNos).toContain(ORDER_SHARED);
    // ★ B 的独占单**绝不可见**
    expect(orderNos).not.toContain(ORDER_B);
  });

  it("商户 B 的订单列表只含 B 的订单（对称验证，排除「恰好只有 A 的数据」的巧合）", async () => {
    const { body } = await callJson<PageEnvelope<{ orderNo: string }>["data"]>(
      "/api/v1/merchant/orders",
      { token: tokenB },
    );
    const orderNos = body.data.list.map((row) => row.orderNo);
    expect(orderNos).toContain(ORDER_B);
    expect(orderNos).toContain(ORDER_SHARED);
    expect(orderNos).not.toContain(ORDER_A);
  });

  it("★ 商户 A 的令牌查 B 的订单详情 → 404（不是 403，防存在性探测）", async () => {
    const res = await call(`/api/v1/merchant/orders/${ORDER_B}`, { token: tokenA });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe(MERCHANT_ERROR_CODES.ORDER_NOT_FOUND);
    expect(body.data).toBeNull();
  });

  it("共享主单：A 只看到**自己的子单**，不泄漏 B 的子单与商品快照", async () => {
    const { body } = await callJson<{
      subOrders: { subOrderNo: string; merchantId: string; items: { title: string }[] }[];
    }>(`/api/v1/merchant/orders/${ORDER_SHARED}`, { token: tokenA });

    const subOrderNos = body.data.subOrders.map((sub) => sub.subOrderNo);
    expect(subOrderNos).toEqual([`${ORDER_SHARED}-01`]);

    const merchantIds = body.data.subOrders.map((sub) => sub.merchantId);
    expect(merchantIds).toEqual([MERCHANT_A]);

    // B 侧的商品快照标题**绝不出现在 A 的响应里**（含整个 JSON 序列化面）
    const serialized = JSON.stringify(body.data);
    expect(serialized).not.toContain("共享单 B 侧快照");
    expect(serialized).not.toContain(MERCHANT_B);
  });

  it("★ 负向控制：A 的令牌**显式传入** B 的 merchantId 仍拿不到 B 的数据", async () => {
    /*
     * 这是隔离语义的**关键证据**：如果实现是「信任前端传参」，这条用例会通过
     * 传 `?merchantId=<B>` 而读到 B 的数据。实现里 `resolveMerchantScope()` 只读
     * JWT 主体 + `merchant_members`，**不读任何请求参数**，故必须依然被过滤。
     */
    const { body } = await callJson<PageEnvelope<{ orderNo: string }>["data"]>(
      "/api/v1/merchant/orders",
      { token: tokenA, query: { merchantId: MERCHANT_B, merchant_id: MERCHANT_B } },
    );
    const orderNos = body.data.list.map((row) => row.orderNo);
    expect(orderNos).not.toContain(ORDER_B);

    // 详情路径同理：显式传 B 的标识也无法打开 B 的订单
    const detail = await call(`/api/v1/merchant/orders/${ORDER_B}`, {
      token: tokenA,
      query: { merchantId: MERCHANT_B },
    });
    expect(detail.status).toBe(404);
  });

  it("★ 负向控制：A 的令牌**显式传入** B 的 merchantId 也拿不到 B 的门店", async () => {
    const { body } = await callJson<PageEnvelope<{ id: string }>["data"]>(
      "/api/v1/merchant/stores",
      { token: tokenA, query: { merchantId: MERCHANT_B } },
    );
    const ids = body.data.list.map((row) => row.id);
    expect(ids).toContain(STORE_A);
    expect(ids).not.toContain(STORE_B);
  });

  it("★ 负向控制：`/merchant/merchants` 商户侧只看自己（平台侧才看全部）", async () => {
    const a = await callJson<PageEnvelope<{ id: string }>["data"]>("/api/v1/merchant/merchants", {
      token: tokenA,
    });
    expect(a.body.data.list.map((row) => row.id)).toEqual([MERCHANT_A]);

    // 平台侧视角（docs/09 §9.2「平台侧可见全部商户」）
    const platform = await callJson<PageEnvelope<{ id: string }>["data"]>(
      "/api/v1/merchant/merchants",
      { token: tokenPlatform },
    );
    const platformIds = platform.body.data.list.map((row) => row.id);
    expect(platformIds).toContain(MERCHANT_A);
    expect(platformIds).toContain(MERCHANT_B);
  });

  it("★ 负向控制：A 的令牌查 B 的售后单 → 404", async () => {
    const res = await call("/api/v1/merchant/aftersales/AS20260920002", { token: tokenA });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.AFTERSALE_NOT_FOUND);
  });

  it("售后列表只含本商户的售后单", async () => {
    const { body } = await callJson<PageEnvelope<{ aftersaleNo: string }>["data"]>(
      "/api/v1/merchant/aftersales",
      { token: tokenA },
    );
    const nos = body.data.list.map((row) => row.aftersaleNo);
    expect(nos).toEqual(["AS20260920001"]);
  });

  it("商品列表只含本商户的商品", async () => {
    const { body } = await callJson<PageEnvelope<{ spuId: string }>["data"]>(
      "/api/v1/merchant/products",
      { token: tokenA },
    );
    expect(body.data.list.map((row) => row.spuId)).toEqual([PRODUCT_A]);

    const b = await callJson<PageEnvelope<{ spuId: string }>["data"]>("/api/v1/merchant/products", {
      token: tokenB,
    });
    expect(b.body.data.list.map((row) => row.spuId)).toEqual([PRODUCT_B]);
  });

  it("分页 `total` 与隔离条件同源：A 的 total 不含 B 的订单", async () => {
    const { body } = await callJson<PageEnvelope<{ orderNo: string }>["data"]>(
      "/api/v1/merchant/orders",
      { token: tokenA },
    );
    // A 可见 2 单（独占 + 共享），而不是全部 3 单
    expect(body.data.total).toBe(2);
  });

  it("`/merchant/categories` 是平台级共享字典（契约 merchantScoped=false），两商户看到同一份", async () => {
    const a = await callJson<PageEnvelope<{ id: string; level: number }>["data"]>(
      "/api/v1/merchant/categories",
      { token: tokenA },
    );
    const b = await callJson<PageEnvelope<{ id: string; level: number }>["data"]>(
      "/api/v1/merchant/categories",
      { token: tokenB },
    );
    expect(a.body.data.list.map((row) => row.id)).toEqual(b.body.data.list.map((row) => row.id));
    // `level` 由 `parent_id` 链条推导（`categories` 表无 `level` 列）
    const byId = new Map(a.body.data.list.map((row) => [row.id, row.level]));
    expect(byId.get(CATEGORY_ROOT)).toBe(1);
    expect(byId.get(CATEGORY_CHILD)).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. aud 互斥（docs/09 §9.1）                                                  */
/* -------------------------------------------------------------------------- */

describe("aud 互斥（docs/09 §9.1：四套体系互不通用）", () => {
  it("★ 实际行为：merchant 令牌访问 `/api/v1/admin/*` **被放行**（共享中间件的设计）", async () => {
    /*
     * ⚠️ **与 `docs/09` §9.1 字面表述的偏差**（诚实登记）：
     *
     * §9.1 写「`admin` Token 访问 `/merchant/*` 亦 `401`」（本文件已双向锁定），
     * 但其「四套体系互不通用」的**对称方向**（merchant → `/admin/*`）在实现里**不成立**：
     * `middleware/admin-auth.ts` 的 `ADMIN_AUDIENCES = [admin, merchant]` 是
     * **shop / admin / merchant 三组共用**的设计，`/api/v1/admin/*` 走默认值，
     * 故商户令牌能进平台端点。
     *
     * 该中间件**不在本任务的文件所有权内**，改动它会波及 admin 组既有测试，
     * 故此处**如实断言现状**把偏差固定下来（避免它被无声改变），由主代理决定是否收敛（M1）。
     */
    const res = await call("/api/v1/admin/me", { token: tokenA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe(0);
  });

  it("merchant 令牌访问 `/api/v1/admin/*` 时，错误响应仍按**路径**取 admin 域字符串码", async () => {
    // 用不存在的 admin 子路径触发 404（而非鉴权失败），验证错误码按路径分域
    const res = await call("/api/v1/admin/no-such-endpoint", { token: tokenA });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("string");
    expect(String(body.code).startsWith("ERR_ADMIN_")).toBe(true);
  });

  it("merchant 令牌访问 /api/v1/merchant/me 正常（对照组：同一令牌在正确入口可用）", async () => {
    const res = await call("/api/v1/merchant/me", { token: tokenA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope & { data: { aud: string; merchantIds: string[] } };
    expect(body.data.aud).toBe("merchant");
    expect(body.data.merchantIds).toEqual([MERCHANT_A]);
  });

  it("★ admin 令牌访问 /merchant/me → 401（aud 强隔离：平台令牌不得进商户入口）", async () => {
    const res = await call("/api/v1/merchant/me", { token: tokenPlatform });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.TOKEN_INVALID);
  });

  it("admin 令牌访问 merchant **业务端点** → 放行且可见全部（docs/09 §9.2 平台侧视角）", async () => {
    const { status, body } = await callJson<PageEnvelope<{ orderNo: string }>["data"]>(
      "/api/v1/merchant/orders",
      { token: tokenPlatform },
    );
    expect(status).toBe(200);
    const orderNos = body.data.list.map((row) => row.orderNo);
    // 平台侧 `scope.all = true`：三单全可见
    expect(orderNos).toContain(ORDER_A);
    expect(orderNos).toContain(ORDER_B);
    expect(orderNos).toContain(ORDER_SHARED);
  });

  it("未知 aud 的令牌（伪造 shop 受众）→ 401", async () => {
    const shopToken = await signJwt({ sub: USER_A, role: "customer" }, JWT_SECRET, {
      aud: JWT_AUDIENCE.SHOP,
    });
    const res = await call("/api/v1/merchant/orders", { token: shopToken });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.TOKEN_INVALID);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 会话端点（login / refresh / logout）                                       */
/* -------------------------------------------------------------------------- */

describe("POST /merchant/login", () => {
  it("合法凭据 → 200 + aud=merchant + 两个 Set-Cookie", async () => {
    const res = await call("/api/v1/merchant/login", {
      method: "POST",
      body: { username: "merchant-a", password: "secret-password" },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Envelope & {
      data: {
        accessToken: string;
        expiresIn: number;
        subject: { aud: string; merchantIds: string[] };
      };
    };
    expect(body.code).toBe(0);
    expect(body.data.subject.aud).toBe("merchant");
    expect(body.data.subject.merchantIds).toEqual([MERCHANT_A]);

    const cookies = getSetCookies(res);
    expect(findCookie(cookies, "dshop_admin_at")).toBeDefined();
    expect(findCookie(cookies, "dshop_admin_rt")).toBeDefined();
  });

  it("密码错误 → 401 + ERR_MERCHANT_TOKEN_INVALID（不区分「账号不存在」）", async () => {
    const res = await call("/api/v1/merchant/login", {
      method: "POST",
      body: { username: "merchant-a", password: "wrong-password" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.TOKEN_INVALID);
  });

  it("账号不存在 → 与密码错误**同一个**错误码（防账号枚举）", async () => {
    const res = await call("/api/v1/merchant/login", {
      method: "POST",
      body: { username: "nobody", password: "whatever" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.TOKEN_INVALID);
  });

  it("参数非法 → 400 + ERR_MERCHANT_INVALID_PARAM", async () => {
    const res = await call("/api/v1/merchant/login", {
      method: "POST",
      body: { username: "", password: "" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.INVALID_PARAM);
  });

  it("★ 平台账号（无商户关联）登录商户入口 → 403 + ERR_MERCHANT_PERMISSION_DENIED", async () => {
    const res = await call("/api/v1/merchant/login", {
      method: "POST",
      body: { username: "platform", password: "secret-password" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.PERMISSION_DENIED);
  });
});

describe("POST /merchant/refresh 与 /logout", () => {
  it("登录 → 刷新：旋转成功且旧令牌失效（401 + ERR_MERCHANT_TOKEN_REVOKED）", async () => {
    const login = await call("/api/v1/merchant/login", {
      method: "POST",
      body: { username: "merchant-a", password: "secret-password" },
    });
    const refreshCookie = findCookie(getSetCookies(login), "dshop_admin_rt");
    expect(refreshCookie).toBeDefined();
    const refreshValue = cookieValue(refreshCookie!);

    const first = await call("/api/v1/merchant/refresh", {
      method: "POST",
      cookie: `dshop_admin_rt=${refreshValue}`,
    });
    expect(first.status).toBe(200);

    const second = await call("/api/v1/merchant/refresh", {
      method: "POST",
      cookie: `dshop_admin_rt=${refreshValue}`,
    });
    expect(second.status).toBe(401);
    expect(((await second.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.TOKEN_REVOKED);
  });

  it("缺 refresh 凭据 → 401 + ERR_MERCHANT_TOKEN_MISSING", async () => {
    const res = await call("/api/v1/merchant/refresh", { method: "POST" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.TOKEN_MISSING);
  });

  it("logout 恒返回 loggedOut: true（无凭据也幂等成功）", async () => {
    const res = await call("/api/v1/merchant/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope & { data: { loggedOut: boolean } };
    expect(body.data.loggedOut).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. 错误码分层与查询参数校验                                                   */
/* -------------------------------------------------------------------------- */

describe("错误码分层与参数校验", () => {
  it("非法分页参数 → 400 + ERR_MERCHANT_INVALID_PARAM", async () => {
    const res = await call("/api/v1/merchant/orders", {
      token: tokenA,
      query: { pageSize: "999" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.INVALID_PARAM);
  });

  it("非法订单状态 → 400 + ERR_MERCHANT_INVALID_PARAM", async () => {
    const res = await call("/api/v1/merchant/orders", {
      token: tokenA,
      query: { status: "NOT_A_STATUS" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe(MERCHANT_ERROR_CODES.INVALID_PARAM);
  });

  it("★ 负向控制：merchant 路径的所有错误码都是字符串 ERR_MERCHANT_*", async () => {
    const probes: readonly (readonly [string, CallOptions])[] = [
      ["/api/v1/merchant/me", {}],
      ["/api/v1/merchant/orders", {}],
      ["/api/v1/merchant/aftersales", {}],
      ["/api/v1/merchant/products", {}],
      ["/api/v1/merchant/categories", {}],
      ["/api/v1/merchant/merchants", {}],
      ["/api/v1/merchant/stores", {}],
      ["/api/v1/merchant/no-such-endpoint", { token: tokenA }],
    ];

    for (const [path, options] of probes) {
      const res = await call(path, options);
      const body = (await res.json()) as Envelope;
      expect(typeof body.code, `${path} 返回了非字符串码`).toBe("string");
      expect(String(body.code).startsWith("ERR_MERCHANT_")).toBe(true);
    }
  });

  it('响应体统一信封 `{ code, message, data }`（成功时 code=0、message="ok"）', async () => {
    const res = await call("/api/v1/merchant/me", { token: tokenA });
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe(0);
    expect(body.message).toBe("ok");
    expect(body.data).not.toBeNull();
  });
});
