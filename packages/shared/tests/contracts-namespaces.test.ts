/**
 * 三个新增命名空间（`/shop`、`/merchant`、`/callbacks`）的契约与错误码分层测试。
 *
 * 覆盖三件事（任务硬性要求）：
 * 1. 端点模板**逐字**与前端封装里的 JSDoc / 端点常量一致（结构性提取源文件，不做宽松正则）；
 * 2. 路径分流：四域各落正确域，且 `/api/v1/agent/*` 未知路径仍是**整数 `40401`**；
 * 3. 每个错误码都有 HTTP 状态映射，且**无重复键**。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CALLBACK_ENDPOINTS, CALLBACK_ROUTE_PREFIX } from "../src/contracts/callbacks.js";
import { MERCHANT_ENDPOINTS, MERCHANT_ROUTE_PREFIX } from "../src/contracts/merchant.js";
import { SHOP_ENDPOINTS, SHOP_ROUTE_PREFIX } from "../src/contracts/shop.js";
import {
  ADMIN_ERROR_CODES,
  AGENT_ERROR_CODES,
  BACKOFFICE_DOMAIN,
  BACKOFFICE_ERROR_META,
  CALLBACK_ERROR_CODES,
  MERCHANT_ERROR_CODES,
  SHOP_ERROR_CODES,
  backofficeDomainForPath,
  backofficeErrorCodesForPath,
  backofficeHttpStatusFor,
  isAgentPath,
} from "../src/errors.js";

/* -------------------------------------------------------------------------- */
/* 源文件结构性提取（不靠宽松正则碰运气）                                      */
/* -------------------------------------------------------------------------- */

function readSource(relativeFromTests: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromTests, import.meta.url)), "utf8");
}

/**
 * 从 `apps/storefront/src/api/client.ts` 的 JSDoc 中提取 `方法 路径` 二元组。
 *
 * JSDoc 里的写法是 `` `GET /api/v1/shop/products?categoryId=&q=&sort=&page=` ``，
 * 故按「方法 + 空格 + 完整路径」的**结构化模式**匹配，再剥掉 query string。
 * 返回去重后的 `"METHOD /path"` 集合。
 */
function extractShopEndpointsFromSource(): Set<string> {
  const source = readSource("../../../apps/storefront/src/api/client.ts");
  const pattern = /(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/v1\/shop[^\s`?]*)/g;
  const found = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const method = match[1];
    const path = match[2];
    if (method === undefined || path === undefined) continue;
    found.add(`${method} ${path}`);
  }
  return found;
}

/**
 * 从 `apps/admin/src/api/endpoints.ts` 的 `MERCHANT_ENDPOINTS` 对象字面量中提取路径。
 *
 * 步骤：先截取对象字面量块，再把 `` `${encodeURIComponent(orderNo)}` `` 归一为
 * `:orderNo`，最后抽取 `/merchant/...` 路径串。方法不在该文件里（由 `services.ts` 决定），
 * 故只比对**路径集合**。
 */
function extractMerchantPathsFromSource(): Set<string> {
  const source = readSource("../../../apps/admin/src/api/endpoints.ts");
  const blockMatch = /export const MERCHANT_ENDPOINTS = \{([\s\S]*?)\} as const;/.exec(source);
  expect(blockMatch).not.toBeNull();
  const block = (blockMatch?.[1] ?? "")
    .replace(/\$\{encodeURIComponent\((\w+)\)\}/g, ":$1")
    .replace(/\$\{(\w+)\}/g, ":$1");
  const found = new Set<string>();
  for (const match of block.matchAll(/\/merchant\/[A-Za-z0-9/:_-]*/g)) {
    found.add(match[0]);
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* 1. 端点模板逐字一致                                                          */
/* -------------------------------------------------------------------------- */

/** shop 组端点全集（20 条，与 `client.ts` 的 JSDoc 一一对应）。 */
const EXPECTED_SHOP_ENDPOINTS: readonly string[] = [
  "GET /shop/products",
  "GET /shop/categories",
  "GET /shop/products/:spuId",
  "GET /shop/cart",
  "POST /shop/cart/items",
  "PUT /shop/cart/items/:id",
  "DELETE /shop/cart/items/:id",
  "GET /shop/checkout/preview",
  "GET /shop/addresses",
  "POST /shop/orders",
  "POST /shop/orders/:orderNo/pay",
  "GET /shop/orders",
  "GET /shop/orders/:orderNo",
  "POST /shop/aftersales",
  "GET /shop/aftersales",
  "GET /shop/aftersales/:aftersaleNo",
  "POST /shop/auth/sms-code",
  "POST /shop/auth/login",
  "POST /shop/auth/logout",
  "GET /shop/auth/me",
];

/** merchant 组端点全集（12 条，与 `MERCHANT_ENDPOINTS` 一一对应）。 */
const EXPECTED_MERCHANT_ENDPOINTS: readonly string[] = [
  "POST /merchant/login",
  "POST /merchant/refresh",
  "POST /merchant/logout",
  "GET /merchant/me",
  "GET /merchant/orders",
  "GET /merchant/orders/:orderNo",
  "GET /merchant/aftersales",
  "GET /merchant/aftersales/:aftersaleNo",
  "GET /merchant/products",
  "GET /merchant/categories",
  "GET /merchant/merchants",
  "GET /merchant/stores",
];

/** callbacks 组端点全集（2 条，任务口径）。 */
const EXPECTED_CALLBACK_ENDPOINTS: readonly string[] = [
  "POST /callbacks/payment/wechat",
  "POST /callbacks/payment/alipay",
];

describe("端点清单（docs/06 §6 五组命名空间）", () => {
  it("shop 端点 20 条，模板逐字一致", () => {
    const actual = Object.values(SHOP_ENDPOINTS).map((e) => `${e.method} ${e.path}`);
    expect(actual).toHaveLength(20);
    expect(actual).toEqual(EXPECTED_SHOP_ENDPOINTS);
  });

  it("shop 端点模板逐字等于 apps/storefront/src/api/client.ts 的 JSDoc 声明", () => {
    const fromSource = extractShopEndpointsFromSource();
    const fromContract = new Set(
      Object.values(SHOP_ENDPOINTS).map((e) => `${e.method} /api/v1${e.path}`),
    );
    // 双向：契约里不许有源文件没声明的端点，源文件声明的端点也必须全部落到契约。
    expect([...fromContract].sort()).toEqual([...fromSource].sort());
  });

  it("shop 路由前缀拼接后与源文件路径一致", () => {
    expect(SHOP_ROUTE_PREFIX).toBe("/api/v1/shop");
    for (const spec of Object.values(SHOP_ENDPOINTS)) {
      expect(spec.path.startsWith("/shop/")).toBe(true);
    }
  });

  it("merchant 端点 12 条，模板逐字一致", () => {
    const actual = Object.values(MERCHANT_ENDPOINTS).map((e) => `${e.method} ${e.path}`);
    expect(actual).toHaveLength(12);
    expect(actual).toEqual(EXPECTED_MERCHANT_ENDPOINTS);
  });

  it("merchant 端点路径逐字等于 apps/admin/src/api/endpoints.ts 的 MERCHANT_ENDPOINTS", () => {
    const fromSource = extractMerchantPathsFromSource();
    const fromContract = new Set(Object.values(MERCHANT_ENDPOINTS).map((e) => e.path));
    expect([...fromContract].sort()).toEqual([...fromSource].sort());
  });

  it("merchant 路由前缀正确", () => {
    expect(MERCHANT_ROUTE_PREFIX).toBe("/api/v1/merchant");
    for (const spec of Object.values(MERCHANT_ENDPOINTS)) {
      expect(spec.path.startsWith("/merchant/")).toBe(true);
    }
  });

  it("merchant 组不含平台专属端点（09 §9.2：Agent 令牌 / 售后政策仅平台）", () => {
    const paths = Object.values(MERCHANT_ENDPOINTS).map((e) => e.path);
    expect(paths.some((p) => p.includes("agent-tokens"))).toBe(false);
    expect(paths.some((p) => p.includes("aftersale-policies"))).toBe(false);
  });

  it("callbacks 端点 2 条，全部 POST 且强制验签", () => {
    const actual = Object.values(CALLBACK_ENDPOINTS).map((e) => `${e.method} ${e.path}`);
    expect(actual).toEqual(EXPECTED_CALLBACK_ENDPOINTS);
    expect(CALLBACK_ROUTE_PREFIX).toBe("/api/v1/callbacks");
    for (const spec of Object.values(CALLBACK_ENDPOINTS)) {
      expect(spec.method).toBe("POST");
      expect(spec.signatureRequired).toBe(true);
    }
  });

  it("POST /shop/orders 与 POST /shop/aftersales 必须带 Idempotency-Key（docs/06 §6）", () => {
    expect(SHOP_ENDPOINTS.CREATE_ORDER.idempotencyKeyRequired).toBe(true);
    expect(SHOP_ENDPOINTS.CREATE_AFTERSALE.idempotencyKeyRequired).toBe(true);
    const others = Object.values(SHOP_ENDPOINTS).filter(
      (e) => e !== SHOP_ENDPOINTS.CREATE_ORDER && e !== SHOP_ENDPOINTS.CREATE_AFTERSALE,
    );
    expect(others.every((e) => !e.idempotencyKeyRequired)).toBe(true);
  });

  it("微信回调响应体为 { code, message }，成功码为 SUCCESS（微信支付 v3）", () => {
    const ack = CALLBACK_ENDPOINTS.WECHAT_PAYMENT.ackSchema.safeParse({
      code: "SUCCESS",
      message: "",
    });
    expect(ack.success).toBe(true);
    expect(
      CALLBACK_ENDPOINTS.WECHAT_PAYMENT.ackSchema.safeParse({ code: 0, message: "ok" }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 路径分流（整数码 vs 字符串码的分层边界）                                  */
/* -------------------------------------------------------------------------- */

describe("路径分流（docs/06:11-15 / docs/README.md:34）", () => {
  it("/api/v1/shop/x → shop 域，取到字符串码", () => {
    expect(backofficeDomainForPath("/api/v1/shop/x")).toBe(BACKOFFICE_DOMAIN.SHOP);
    expect(backofficeErrorCodesForPath("/api/v1/shop/x").NOT_FOUND).toBe(
      SHOP_ERROR_CODES.NOT_FOUND,
    );
    expect(backofficeErrorCodesForPath("/api/v1/shop/x").NOT_FOUND.startsWith("ERR_SHOP_")).toBe(
      true,
    );
  });

  it("/api/v1/merchant/x → merchant 域，取到字符串码", () => {
    expect(backofficeDomainForPath("/api/v1/merchant/x")).toBe(BACKOFFICE_DOMAIN.MERCHANT);
    expect(backofficeErrorCodesForPath("/api/v1/merchant/x").NOT_FOUND).toBe(
      MERCHANT_ERROR_CODES.NOT_FOUND,
    );
  });

  it("/api/v1/callbacks/x → callbacks 域，取到字符串码", () => {
    expect(backofficeDomainForPath("/api/v1/callbacks/x")).toBe(BACKOFFICE_DOMAIN.CALLBACK);
    expect(backofficeErrorCodesForPath("/api/v1/callbacks/x").NOT_FOUND).toBe(
      CALLBACK_ERROR_CODES.NOT_FOUND,
    );
  });

  it("/api/v1/admin/x → admin 域，取到字符串码", () => {
    expect(backofficeDomainForPath("/api/v1/admin/x")).toBe(BACKOFFICE_DOMAIN.ADMIN);
    expect(backofficeErrorCodesForPath("/api/v1/admin/x").NOT_FOUND).toBe(
      ADMIN_ERROR_CODES.NOT_FOUND,
    );
  });

  it("/api/v1/agent/x 未知路径 → 整数 40401（既有行为不得改变）", () => {
    expect(isAgentPath("/api/v1/agent/x")).toBe(true);
    expect(isAgentPath("/api/v1/agent")).toBe(true);
    expect(AGENT_ERROR_CODES.ORDER_NOT_FOUND).toBe(40401);
    // 整数码表与字符串码表值域完全不重叠
    expect(typeof AGENT_ERROR_CODES.ORDER_NOT_FOUND).toBe("number");
    for (const value of Object.values(SHOP_ERROR_CODES)) {
      expect(typeof value).toBe("string");
    }
  });

  it("前缀按路径段判定，不误吞同前缀的邻居（/api/v1/shopx ≠ shop）", () => {
    expect(backofficeDomainForPath("/api/v1/shopx")).toBe(BACKOFFICE_DOMAIN.ADMIN);
    expect(backofficeDomainForPath("/api/v1/merchants")).toBe(BACKOFFICE_DOMAIN.ADMIN);
    expect(isAgentPath("/api/v1/agents")).toBe(false);
  });

  it("四个非 Agent 域与 Agent 前缀互斥", () => {
    const nonAgent = [
      "/api/v1/shop/x",
      "/api/v1/merchant/x",
      "/api/v1/admin/x",
      "/api/v1/callbacks/x",
    ];
    for (const path of nonAgent) {
      expect(isAgentPath(path)).toBe(false);
    }
    expect(isAgentPath("/api/v1/agent/orders")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 错误码：HTTP 映射齐全 + 无重复键                                          */
/* -------------------------------------------------------------------------- */

describe("错误码表（四域字符串码，docs/06:20）", () => {
  const tables = {
    ADMIN: ADMIN_ERROR_CODES,
    SHOP: SHOP_ERROR_CODES,
    MERCHANT: MERCHANT_ERROR_CODES,
    CALLBACK: CALLBACK_ERROR_CODES,
  } as const;

  it("每个域的错误码均为 ERR_<域>_<原因> 形式", () => {
    for (const [prefix, table] of Object.entries(tables)) {
      for (const value of Object.values(table)) {
        expect(value.startsWith(`ERR_${prefix}_`)).toBe(true);
        expect(/^ERR_[A-Z0-9_]+$/.test(value)).toBe(true);
      }
    }
  });
  it("每个错误码都有 HTTP 映射（400/401/403/404/409/429/500）", () => {
    const allowed = new Set([400, 401, 403, 404, 409, 429, 500]);
    for (const table of Object.values(tables)) {
      for (const code of Object.values(table)) {
        const meta = BACKOFFICE_ERROR_META[code];
        expect(meta, `缺少 HTTP 映射：${code}`).toBeDefined();
        expect(typeof meta?.http).toBe("number");
        expect(allowed.has(meta?.http ?? 0)).toBe(true);
        expect((meta?.message ?? "").length).toBeGreaterThan(0);
        expect(backofficeHttpStatusFor(code)).toBe(meta?.http);
      }
    }
  });

  it("无重复键（跨四域也不重复）", () => {
    const all = Object.values(tables).flatMap((table) => Object.values(table));
    expect(all.length).toBe(new Set(all).size);
    // 元信息表也必须是同一组键（对象字面量的重复键会静默合并，故反向核对）
    expect(Object.keys(BACKOFFICE_ERROR_META).length).toBe(new Set(all).size);
    for (const code of all) {
      expect(Object.prototype.hasOwnProperty.call(BACKOFFICE_ERROR_META, code)).toBe(true);
    }
  });

  it("整数码与字符串码值域完全不重叠", () => {
    const ints = new Set<number>(Object.values(AGENT_ERROR_CODES));
    for (const table of Object.values(tables)) {
      for (const code of Object.values(table)) {
        expect(ints.has(Number(code))).toBe(false);
      }
    }
  });

  it("任务点名的关键码存在且语义正确", () => {
    expect(SHOP_ERROR_CODES.UNAUTHORIZED).toBe("ERR_SHOP_UNAUTHORIZED");
    expect(SHOP_ERROR_CODES.STOCK_INSUFFICIENT).toBe("ERR_SHOP_STOCK_INSUFFICIENT");
    expect(SHOP_ERROR_CODES.IDEMPOTENCY_CONFLICT).toBe("ERR_SHOP_IDEMPOTENCY_CONFLICT");
    expect(MERCHANT_ERROR_CODES.FORBIDDEN).toBe("ERR_MERCHANT_FORBIDDEN");
    expect(CALLBACK_ERROR_CODES.SIGNATURE_INVALID).toBe("ERR_CALLBACK_SIGNATURE_INVALID");

    expect(backofficeHttpStatusFor(SHOP_ERROR_CODES.STOCK_INSUFFICIENT)).toBe(409);
    expect(backofficeHttpStatusFor(SHOP_ERROR_CODES.UNAUTHORIZED)).toBe(401);
    expect(backofficeHttpStatusFor(SHOP_ERROR_CODES.IDEMPOTENCY_CONFLICT)).toBe(409);
    expect(backofficeHttpStatusFor(MERCHANT_ERROR_CODES.FORBIDDEN)).toBe(403);
    expect(backofficeHttpStatusFor(CALLBACK_ERROR_CODES.SIGNATURE_INVALID)).toBe(401);
  });

  it("四个域的错误码表结构同构（公共键齐全，便于按路径取表）", () => {
    const commonKeys = [
      "INVALID_PARAM",
      "TOKEN_MISSING",
      "TOKEN_INVALID",
      "TOKEN_REVOKED",
      "PERMISSION_DENIED",
      "NOT_FOUND",
      "INTERNAL_ERROR",
    ] as const;
    for (const table of Object.values(tables)) {
      for (const key of commonKeys) {
        expect(typeof table[key]).toBe("string");
      }
    }
  });

  it("未知字符串码降级为 500（不抛异常）", () => {
    expect(backofficeHttpStatusFor("ERR_SHOP_NOPE")).toBe(500);
  });
});
