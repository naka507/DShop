/**
 * shop 组错误码分流测试。
 *
 * 权威来源：`docs/06-API路由命名空间.md` §6：
 * - 统一响应体 `{code, message, data}`，`code === 0` 为成功；
 * - **`/api/v1/shop/*` 用字符串错误码**（`ERR_SHOP_*`），
 *   与 Agent 组的**整数**错误码**不混用**。
 * - `docs/README.md`「错误码」条目：Agent 组用整数码；shop/admin/merchant 用字符串码。
 *
 * 同时验证 `transport.ts` 的**同源转发铁律**：绝对 URL 必须被拒绝
 * （`docs/09-认证权限与部署.md` §10.2：同 zone 绝对 URL 会绕回发起方，静默 404）。
 */

import { describe, expect, it } from "vitest";

import {
  SHOP_ERROR_KIND,
  SHOP_ERROR_PREFIX,
  ShopHttpError,
  classifyShopErrorCode,
  classifyShopHttpStatus,
  describeShopError,
  isShopHttpError,
  isSuccessCode,
} from "../src/api/errors.ts";
import { buildUrl, createRequester, request } from "../src/api/transport.ts";

/** 构造一个统一响应体响应。 */
function envelopeResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("classifyShopErrorCode（字符串错误码分流）", () => {
  it("剥离 ERR_SHOP_ 前缀后按关键字分流", () => {
    expect(classifyShopErrorCode("ERR_SHOP_ORDER_STOCK_NOT_ENOUGH")).toBe(SHOP_ERROR_KIND.STOCK);
    expect(classifyShopErrorCode("ERR_SHOP_UNAUTHORIZED")).toBe(SHOP_ERROR_KIND.UNAUTHORIZED);
    expect(classifyShopErrorCode("ERR_SHOP_ORDER_NOT_FOUND")).toBe(SHOP_ERROR_KIND.NOT_FOUND);
    expect(classifyShopErrorCode("ERR_SHOP_IDEMPOTENCY_CONFLICT")).toBe(SHOP_ERROR_KIND.CONFLICT);
    expect(classifyShopErrorCode("ERR_SHOP_RATE_LIMITED")).toBe(SHOP_ERROR_KIND.RATE_LIMITED);
    expect(classifyShopErrorCode("ERR_SHOP_PARAM_INVALID")).toBe(SHOP_ERROR_KIND.VALIDATION);
    expect(classifyShopErrorCode("ERR_SHOP_INTERNAL_ERROR")).toBe(SHOP_ERROR_KIND.SERVER);
  });

  it("无前缀的裸错误码同样可分流（后端可能不统一加前缀）", () => {
    expect(classifyShopErrorCode("ORDER_STOCK_NOT_ENOUGH")).toBe(SHOP_ERROR_KIND.STOCK);
  });

  it("大小写不敏感", () => {
    expect(classifyShopErrorCode("err_shop_order_not_found")).toBe(SHOP_ERROR_KIND.NOT_FOUND);
  });

  it("未识别的错误码归入 UNKNOWN，不抛错（新增码不阻断流程）", () => {
    expect(classifyShopErrorCode("ERR_SHOP_SOMETHING_BRAND_NEW")).toBe(SHOP_ERROR_KIND.UNKNOWN);
    expect(classifyShopErrorCode("")).toBe(SHOP_ERROR_KIND.UNKNOWN);
  });

  it("前缀常量与文档口径一致（ERR_SHOP_）", () => {
    expect(SHOP_ERROR_PREFIX).toBe("ERR_SHOP_");
  });
});

describe("classifyShopHttpStatus（无错误码时的兜底）", () => {
  it("按 HTTP 状态码分流", () => {
    expect(classifyShopHttpStatus(401)).toBe(SHOP_ERROR_KIND.UNAUTHORIZED);
    expect(classifyShopHttpStatus(403)).toBe(SHOP_ERROR_KIND.FORBIDDEN);
    expect(classifyShopHttpStatus(404)).toBe(SHOP_ERROR_KIND.NOT_FOUND);
    expect(classifyShopHttpStatus(409)).toBe(SHOP_ERROR_KIND.CONFLICT);
    expect(classifyShopHttpStatus(422)).toBe(SHOP_ERROR_KIND.VALIDATION);
    expect(classifyShopHttpStatus(429)).toBe(SHOP_ERROR_KIND.RATE_LIMITED);
    expect(classifyShopHttpStatus(503)).toBe(SHOP_ERROR_KIND.SERVER);
  });

  it("status=0（网络层失败）归入 SERVER", () => {
    expect(classifyShopHttpStatus(0)).toBe(SHOP_ERROR_KIND.SERVER);
  });
});

describe("ShopHttpError", () => {
  it("有错误码时优先按错误码分流，并给出可操作文案", () => {
    const error = new ShopHttpError({
      code: "ERR_SHOP_ORDER_STOCK_NOT_ENOUGH",
      message: "库存不足",
      status: 400,
    });

    expect(error.kind).toBe(SHOP_ERROR_KIND.STOCK);
    expect(error.requiresLogin).toBe(false);
    expect(error.retryable).toBe(false);
    expect(describeShopError(error)).toBe("库存不足，请调整购买数量");
  });

  it("401 无错误码时要求重新登录", () => {
    const error = new ShopHttpError({ code: "", message: "", status: 401 });
    expect(error.requiresLogin).toBe(true);
    expect(describeShopError(error)).toBe("登录状态已失效，请重新登录");
  });

  it("限流与服务端错误标记为可重试", () => {
    expect(
      new ShopHttpError({ code: "ERR_SHOP_RATE_LIMITED", message: "", status: 429 }).retryable,
    ).toBe(true);
    expect(new ShopHttpError({ code: "", message: "", status: 500 }).retryable).toBe(true);
  });

  it("保留 requestId 以便与 access_log 对账", () => {
    const error = new ShopHttpError({
      code: "ERR_SHOP_X",
      message: "x",
      status: 400,
      requestId: "req-1",
    });
    expect(error.requestId).toBe("req-1");
  });

  it("isShopHttpError 类型守卫", () => {
    expect(isShopHttpError(new ShopHttpError({ code: "", message: "", status: 500 }))).toBe(true);
    expect(isShopHttpError(new Error("普通错误"))).toBe(false);
  });
});

describe("isSuccessCode（统一响应体判定）", () => {
  it("数字 0 与字符串 '0' 都视为成功", () => {
    expect(isSuccessCode(0)).toBe(true);
    expect(isSuccessCode("0")).toBe(true);
  });

  it("Agent 组的整数码与 shop 组的字符串码都判为非成功", () => {
    expect(isSuccessCode(40001)).toBe(false);
    expect(isSuccessCode("ERR_SHOP_ORDER_NOT_FOUND")).toBe(false);
  });
});

describe("buildUrl（同源转发铁律）", () => {
  it("相对路径原样保留", () => {
    expect(buildUrl("/products")).toBe("/products");
  });

  it("查询参数按存在性拼接，undefined/null 被丢弃", () => {
    expect(buildUrl("/products", { q: "耳机", page: 1, sort: undefined, extra: null })).toBe(
      "/products?q=%E8%80%B3%E6%9C%BA&page=1",
    );
  });

  it("绝对 URL 直接抛错（docs/09 §10.2 同源转发铁律）", () => {
    expect(() => buildUrl("https://api.dshop.example.com/api/v1/shop/products")).toThrow(
      /同源转发铁律/,
    );
    expect(() => buildUrl("http://127.0.0.1:8787/api/v1/shop/products")).toThrow(/同源转发铁律/);
  });
});

describe("request（统一响应体解包与错误分流）", () => {
  it("code === 0 时解包 data 并拼上 /api/v1/shop 前缀", async () => {
    let seenUrl = "";
    const requester = createRequester((input) => {
      seenUrl = input;
      return Promise.resolve(envelopeResponse({ code: 0, message: "ok", data: { total: 1 } }));
    });

    const data = await requester<{ total: number }>("/orders", { query: { page: 1 } });

    expect(data).toEqual({ total: 1 });
    expect(seenUrl).toBe("/api/v1/shop/orders?page=1");
  });

  it("非 0 字符串错误码 → 抛 ShopHttpError 并分流为 STOCK", async () => {
    const requester = createRequester(() =>
      Promise.resolve(
        envelopeResponse(
          { code: "ERR_SHOP_ORDER_STOCK_NOT_ENOUGH", message: "库存不足", data: null },
          { status: 400 },
        ),
      ),
    );

    await expect(requester("/orders", { method: "POST" })).rejects.toBeInstanceOf(ShopHttpError);
    try {
      await requester("/orders", { method: "POST" });
      throw new Error("应当抛错");
    } catch (error) {
      expect(isShopHttpError(error)).toBe(true);
      if (isShopHttpError(error)) {
        expect(error.kind).toBe(SHOP_ERROR_KIND.STOCK);
        expect(error.code).toBe("ERR_SHOP_ORDER_STOCK_NOT_ENOUGH");
      }
    }
  });

  it("HTTP 200 + 业务错误码（后端常见形态）也能正确抛错", async () => {
    const requester = createRequester(() =>
      Promise.resolve(
        envelopeResponse({ code: "ERR_SHOP_UNAUTHORIZED", message: "未登录", data: null }),
      ),
    );

    try {
      await requester("/auth/me");
      throw new Error("应当抛错");
    } catch (error) {
      expect(isShopHttpError(error)).toBe(true);
      if (isShopHttpError(error)) expect(error.requiresLogin).toBe(true);
    }
  });

  it("非统一响应体 → 抛 ShopHttpError（提示契约不符）", async () => {
    const requester = createRequester(() =>
      Promise.resolve(new Response("<html>404</html>", { status: 404 })),
    );

    try {
      await requester("/products");
      throw new Error("应当抛错");
    } catch (error) {
      expect(isShopHttpError(error)).toBe(true);
      if (isShopHttpError(error)) {
        expect(error.status).toBe(404);
        expect(error.kind).toBe(SHOP_ERROR_KIND.NOT_FOUND);
      }
    }
  });

  it("网络层失败 → status 0 且归入 SERVER（可重试）", async () => {
    const requester = createRequester(() => Promise.reject(new Error("断网")));

    try {
      await requester("/products");
      throw new Error("应当抛错");
    } catch (error) {
      expect(isShopHttpError(error)).toBe(true);
      if (isShopHttpError(error)) {
        expect(error.status).toBe(0);
        expect(error.retryable).toBe(true);
      }
    }
  });

  it("受控写带 Idempotency-Key 请求头（docs/06 §6）", async () => {
    let seenInit: RequestInit | undefined;
    await request(
      "/orders",
      {
        method: "POST",
        body: { addressId: "01J9Z8K2M4N5P6Q7R8S9T0V1W2" },
        idempotencyKey: "key-1",
      },
      (_input, init) => {
        seenInit = init;
        return Promise.resolve(envelopeResponse({ code: 0, message: "ok", data: {} }));
      },
    );

    const headers = new Headers(seenInit?.headers);
    expect(seenInit?.method).toBe("POST");
    expect(headers.get("Idempotency-Key")).toBe("key-1");
    expect(headers.get("Content-Type")).toBe("application/json");
    // HttpOnly Cookie 双模鉴权（docs/09 §9.1）：同源下必须带凭证。
    expect(seenInit?.credentials).toBe("include");
  });

  it("拒绝绝对 URL（不会发出公网请求）", async () => {
    const requester = createRequester(() =>
      Promise.resolve(envelopeResponse({ code: 0, message: "ok", data: {} })),
    );
    await expect(requester("https://api.dshop.example.com/api/v1/shop/products")).rejects.toThrow(
      /同源转发铁律/,
    );
  });
});

describe("与 packages/shared 的 SHOP_ERROR_CODES 对齐", () => {
  it("权威表里的每个 shop 错误码都能被分流（不是 UNKNOWN）", async () => {
    // 直接读并行同事在 packages/shared/src/errors.ts 新增的权威表，
    // 保证「前端分流」与「后端定义」不会各自漂移。
    const { SHOP_ERROR_CODES } = await import("@dshop/shared");
    const codes = Object.values(SHOP_ERROR_CODES);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(classifyShopErrorCode(code)).not.toBe(SHOP_ERROR_KIND.UNKNOWN);
    }
  });

  it("关键码的分流结果符合语义", async () => {
    const { SHOP_ERROR_CODES } = await import("@dshop/shared");
    expect(classifyShopErrorCode(SHOP_ERROR_CODES.TOKEN_MISSING)).toBe(
      SHOP_ERROR_KIND.UNAUTHORIZED,
    );
    expect(classifyShopErrorCode(SHOP_ERROR_CODES.TOKEN_INVALID)).toBe(
      SHOP_ERROR_KIND.UNAUTHORIZED,
    );
    expect(classifyShopErrorCode(SHOP_ERROR_CODES.TOKEN_REVOKED)).toBe(
      SHOP_ERROR_KIND.UNAUTHORIZED,
    );
    expect(classifyShopErrorCode(SHOP_ERROR_CODES.PERMISSION_DENIED)).toBe(
      SHOP_ERROR_KIND.FORBIDDEN,
    );
    expect(classifyShopErrorCode(SHOP_ERROR_CODES.NOT_FOUND)).toBe(SHOP_ERROR_KIND.NOT_FOUND);
    expect(classifyShopErrorCode(SHOP_ERROR_CODES.INVALID_PARAM)).toBe(SHOP_ERROR_KIND.VALIDATION);
    expect(classifyShopErrorCode(SHOP_ERROR_CODES.INTERNAL_ERROR)).toBe(SHOP_ERROR_KIND.SERVER);
  });
});
