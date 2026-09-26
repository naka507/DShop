/**
 * `@dshop/api-client` 测试。
 *
 * 覆盖三件事（`docs/03:31` 要求本包存在，且必须真能安全调用）：
 * 1. 统一响应体 `{ code, message, data }` 解包（`docs/06:18`）；
 * 2. **两套错误码分流**：Agent 整数码 vs 后台字符串码（`docs/README.md:34`）；
 * 3. Agent 组鉴权头是 **`X-Service-Token`**，**不是** `Authorization: Bearer`（`docs/07` §7.8.1）。
 *
 * 另覆盖 `304`（`docs/07:150`）与 `data` 契约校验（契约即类型）。
 */

import { AgentErrorCodeSchema } from "@dshop/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApiClient } from "../src/index.js";
import {
  authHeadersFor,
  BackofficeFailureSchema,
  buildQueryString,
  decodeEnvelope,
  GROUP_PREFIX,
  isAgentFailure,
  isBackofficeFailure,
  isOk,
  SERVICE_TOKEN_HEADER,
  UnwrapError,
  unwrap,
} from "../src/index.js";

/* -------------------------------------------------------------------------- */
/* 测试工具：可编排的假 fetch                                                    */
/* -------------------------------------------------------------------------- */

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/**
 * 构造「按请求回放」的假 `fetch`，并记录**每一次**请求。
 *
 * 每次调用都新建一个 `Response`：`Response` 的 body 只能读一次，
 * 复用同一个实例会在第二次调用时抛 `Body has already been read`。
 *
 * 刻意不引 msw 等依赖：本包测试只需「回放一次响应」。
 */
function stubFetch(response: () => Response): {
  fetch: typeof fetch;
  requests: CapturedRequest[];
  last: () => CapturedRequest | undefined;
} {
  const requests: CapturedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key] = value;
    }
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return response();
  };
  return {
    fetch: impl as unknown as typeof fetch,
    requests,
    last: () => requests[requests.length - 1],
  };
}

/** 构造 JSON 响应。 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

const SampleSchema = z.object({ id: z.string(), count: z.number() });

/* -------------------------------------------------------------------------- */
/* 1. 响应解包                                                                  */
/* -------------------------------------------------------------------------- */

describe("统一响应体解包", () => {
  it("成功：code=0 且 data 通过 schema → ApiSuccess", () => {
    const result = decodeEnvelope({
      path: "/api/v1/agent/orders/DS1",
      status: 200,
      headers: new Headers({ "X-Cache": "MISS" }),
      body: JSON.stringify({ code: 0, message: "ok", data: { id: "a", count: 2 } }),
      dataSchema: SampleSchema,
    });

    expect(isOk(result)).toBe(true);
    expect(result.ok).toBe(true);
    if (result.ok && !result.notModified) {
      expect(result.data).toEqual({ id: "a", count: 2 });
      expect(result.message).toBe("ok");
      expect(result.headers.get("X-Cache")).toBe("MISS");
    }
  });

  it("data 不符合契约 → 失败（契约即类型，脏数据不交给调用方）", () => {
    const result = decodeEnvelope({
      path: "/api/v1/agent/orders/DS1",
      status: 200,
      headers: new Headers(),
      body: JSON.stringify({ code: 0, message: "ok", data: { id: "a", count: "两件" } }),
      dataSchema: SampleSchema,
    });
    expect(result.ok).toBe(false);
  });

  it("304 → ApiNotModified（ok=true 但 data 为空）", () => {
    const result = decodeEnvelope({
      path: "/api/v1/agent/policies/all",
      status: 304,
      headers: new Headers({ ETag: '"sha256:aaa"' }),
      body: "",
      dataSchema: SampleSchema,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.notModified) {
      expect(result.status).toBe(304);
      expect(result.data).toBeNull();
    } else {
      throw new Error("304 应解为 ApiNotModified");
    }
  });

  it("非 JSON 体（如网关 HTML 错误页）→ 失败而非抛错", () => {
    const result = decodeEnvelope({
      path: "/api/v1/shop/products",
      status: 502,
      headers: new Headers(),
      body: "<html>Bad Gateway</html>",
      dataSchema: SampleSchema,
    });
    expect(result.ok).toBe(false);
    expect(isBackofficeFailure(result)).toBe(true);
  });

  it("信封结构不符 → 失败", () => {
    const result = decodeEnvelope({
      path: "/api/v1/shop/products",
      status: 200,
      headers: new Headers(),
      body: JSON.stringify({ ok: true, result: [] }),
      dataSchema: SampleSchema,
    });
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 错误码分流                                                                */
/* -------------------------------------------------------------------------- */

describe("错误码分流（Agent 整数码 vs 后台字符串码）", () => {
  it("Agent 路径 + 整数码 → AgentFailure，code 为整数联合类型", () => {
    const result = decodeEnvelope({
      path: "/api/v1/agent/orders/DS20260101000000001",
      status: 404,
      headers: new Headers(),
      body: JSON.stringify({ code: 40401, message: "订单不存在", data: null }),
      dataSchema: SampleSchema,
    });

    expect(isAgentFailure(result)).toBe(true);
    if (isAgentFailure(result)) {
      expect(result.kind).toBe("agent");
      expect(result.code).toBe(40401);
      // 类型层面：code 属于 AgentErrorCode 值域
      expect(AgentErrorCodeSchema.safeParse(result.code).success).toBe(true);
    }
  });

  it("Agent 429 → AgentFailure 带 Retry-After", () => {
    const result = decodeEnvelope({
      path: "/api/v1/agent/orders/DS1",
      status: 429,
      headers: new Headers({ "Retry-After": "42" }),
      body: JSON.stringify({ code: 42901, message: "触发限流", data: null }),
      dataSchema: SampleSchema,
    });
    if (isAgentFailure(result)) {
      expect(result.code).toBe(42901);
      expect(result.retryAfterSeconds).toBe(42);
    } else {
      throw new Error("应为 AgentFailure");
    }
  });

  it("Agent 路径返回未知整数码 → 归一到 50001 且保留 rawCode", () => {
    const result = decodeEnvelope({
      path: "/api/v1/agent/orders/DS1",
      status: 500,
      headers: new Headers(),
      body: JSON.stringify({ code: 99999, message: "未知", data: null }),
      dataSchema: SampleSchema,
    });
    if (isAgentFailure(result)) {
      expect(result.code).toBe(50001);
      expect(result.rawCode).toBe(99999);
    } else {
      throw new Error("应为 AgentFailure");
    }
  });

  it("后台路径 + 字符串码 → BackofficeFailure，code 原样保留", () => {
    const result = decodeEnvelope({
      path: "/api/v1/admin/agent-tokens",
      status: 403,
      headers: new Headers(),
      body: JSON.stringify({
        code: "ERR_ADMIN_PERMISSION_DENIED",
        message: "缺少所需权限",
        data: null,
      }),
      dataSchema: SampleSchema,
    });

    expect(isBackofficeFailure(result)).toBe(true);
    if (isBackofficeFailure(result)) {
      expect(result.kind).toBe("backoffice");
      expect(result.code).toBe("ERR_ADMIN_PERMISSION_DENIED");
      expect(BackofficeFailureSchema.safeParse(result).success).toBe(true);
    }
  });

  it("后台路径的整数码不误判为 AgentFailure（按路径分流，不按 code 类型）", () => {
    const result = decodeEnvelope({
      path: "/api/v1/shop/cart/items",
      status: 400,
      headers: new Headers(),
      body: JSON.stringify({ code: 400, message: "坏请求", data: null }),
      dataSchema: SampleSchema,
    });
    expect(isBackofficeFailure(result)).toBe(true);
    expect(isAgentFailure(result)).toBe(false);
  });

  it("Agent 路径的字符串码归一到 50001（形态以路径为准）", () => {
    const result = decodeEnvelope({
      path: "/api/v1/agent/orders",
      status: 500,
      headers: new Headers(),
      body: JSON.stringify({ code: "ERR_X", message: "x", data: null }),
      dataSchema: SampleSchema,
    });
    expect(isAgentFailure(result)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. X-Service-Token 头设置                                                    */
/* -------------------------------------------------------------------------- */

describe("鉴权头", () => {
  it("Agent 组 → X-Service-Token，**不含** Authorization", () => {
    const headers = authHeadersFor("agent", {
      baseUrl: "https://api.dshop.example.com",
      serviceToken: "dshop_svc_abcdefghijklmnopqrstuvwx_123456",
      bearerToken: "should-be-ignored",
    });
    expect(headers[SERVICE_TOKEN_HEADER]).toBe("dshop_svc_abcdefghijklmnopqrstuvwx_123456");
    expect(headers.Authorization).toBeUndefined();
  });

  it("shop / merchant / admin → Authorization: Bearer，**不含** X-Service-Token", () => {
    for (const group of ["shop", "merchant", "admin"] as const) {
      const headers = authHeadersFor(group, {
        baseUrl: "https://api.dshop.example.com",
        bearerToken: "jwt-token",
        serviceToken: "should-be-ignored",
      });
      expect(headers.Authorization, group).toBe("Bearer jwt-token");
      expect(headers[SERVICE_TOKEN_HEADER], group).toBeUndefined();
    }
  });

  it("令牌为函数时每次调用重新取值（支持运行时轮换，docs/07:333）", () => {
    let current = "token-v1";
    const headers = authHeadersFor("agent", {
      baseUrl: "https://api.dshop.example.com",
      serviceToken: () => current,
    });
    expect(headers[SERVICE_TOKEN_HEADER]).toBe("token-v1");

    current = "token-v2";
    expect(
      authHeadersFor("agent", {
        baseUrl: "https://api.dshop.example.com",
        serviceToken: () => current,
      })[SERVICE_TOKEN_HEADER],
    ).toBe("token-v2");
  });

  it("缺失令牌 → 不写该头（服务端回 401 + 40101）", () => {
    expect(authHeadersFor("agent", { baseUrl: "https://x" })).toEqual({});
    expect(authHeadersFor("admin", { baseUrl: "https://x" })).toEqual({});
  });

  it("端到端：Agent 调用实际发出的请求头含 X-Service-Token 与 X-Contract-Version", async () => {
    const { fetch, last } = stubFetch(() =>
      jsonResponse({ code: 0, message: "ok", data: { id: "a", count: 1 } }),
    );
    const client = createApiClient({
      baseUrl: "https://api.dshop.example.com",
      serviceToken: "dshop_svc_abcdefghijklmnopqrstuvwx_123456",
      fetch,
    });

    await client.agent.listOrders({ userId: "01J9Z8K2M4N5P6Q7R8S9T0Z002" });

    const request = last();
    expect(request?.url).toBe(
      "https://api.dshop.example.com/api/v1/agent/orders?userId=01J9Z8K2M4N5P6Q7R8S9T0Z002",
    );
    expect(request?.headers[SERVICE_TOKEN_HEADER]).toBe(
      "dshop_svc_abcdefghijklmnopqrstuvwx_123456",
    );
    expect(request?.headers.Authorization).toBeUndefined();
    expect(request?.headers["X-Contract-Version"]).toBe("1");
  });

  it("端到端：后台调用发出 Bearer，且不带 X-Contract-Version", async () => {
    const { fetch, last } = stubFetch(() =>
      jsonResponse({ code: "ERR_ADMIN_NOT_FOUND", message: "资源不存在", data: null }, 404),
    );
    const client = createApiClient({
      baseUrl: "https://api.dshop.example.com",
      bearerToken: "admin-jwt",
      fetch,
    });

    const result = await client.admin.logout();
    expect(isBackofficeFailure(result)).toBe(true);

    const request = last();
    expect(request?.url).toBe("https://api.dshop.example.com/api/v1/admin/logout");
    expect(request?.headers.Authorization).toBe("Bearer admin-jwt");
    expect(request?.headers["X-Contract-Version"]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 端到端：304 与 unwrap                                                     */
/* -------------------------------------------------------------------------- */

describe("条件请求与 unwrap", () => {
  it("304 响应 → ApiNotModified，且客户端不尝试解析空 body", async () => {
    const { fetch } = stubFetch(
      () => new Response(null, { status: 304, headers: { ETag: '"x"' } }),
    );
    const client = createApiClient({
      baseUrl: "https://api.dshop.example.com",
      serviceToken: "t",
      fetch,
    });

    const result = await client.agent.getPolicies("all", { ifNoneMatch: "sha256:aaa" });
    expect(result.ok).toBe(true);
    if (result.ok && result.notModified) {
      expect(result.status).toBe(304);
    } else {
      throw new Error("应为 ApiNotModified");
    }
  });

  it("unwrap 成功时返回 data，失败时抛 ApiError 且携带完整结果", () => {
    const ok = decodeEnvelope({
      path: "/api/v1/agent/orders/DS1",
      status: 200,
      headers: new Headers(),
      body: JSON.stringify({ code: 0, message: "ok", data: { id: "a", count: 1 } }),
      dataSchema: SampleSchema,
    });
    expect(unwrap(ok)).toEqual({ id: "a", count: 1 });

    const bad = decodeEnvelope({
      path: "/api/v1/agent/orders/DS1",
      status: 404,
      headers: new Headers(),
      body: JSON.stringify({ code: 40401, message: "订单不存在", data: null }),
      dataSchema: SampleSchema,
    });
    let thrown: unknown;
    try {
      unwrap(bad);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnwrapError);
    expect((thrown as UnwrapError).code).toBe(40401);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. 路径与查询串                                                              */
/* -------------------------------------------------------------------------- */

describe("路径与查询串", () => {
  it("四组前缀与 docs/06:11-15 逐字一致", () => {
    expect(GROUP_PREFIX).toEqual({
      shop: "/api/v1/shop",
      merchant: "/api/v1/merchant",
      admin: "/api/v1/admin",
      agent: "/api/v1/agent",
    });
  });

  it("buildQueryString 跳过 undefined 并做 URL 编码", () => {
    expect(buildQueryString(undefined)).toBe("");
    expect(buildQueryString({})).toBe("");
    expect(buildQueryString({ limit: 5, cursor: undefined })).toBe("?limit=5");
    expect(buildQueryString({ status: "PAID,SHIPPED" })).toBe("?status=PAID%2CSHIPPED");
  });

  it("六个 Agent 端点各自发出与 docs/07 §7.2–§7.7 逐字一致的路径", async () => {
    const { fetch, requests } = stubFetch(() =>
      jsonResponse({ code: 40401, message: "订单不存在", data: null }, 404),
    );
    const client = createApiClient({ baseUrl: "https://x", serviceToken: "t", fetch });

    // 响应形状刻意不匹配：本用例只关心**发出的 URL**
    await client.agent.getOrder("DS20260920143000123");
    await client.agent.listOrders({ userId: "01J9Z8K2M4N5P6Q7R8S9T0Z002", limit: 5 });
    await client.agent.getProductSpecs("01J9Z8K2M4N5P6Q7R8S9T0V1W2");
    await client.agent.getProductStock("01J9Z8K2M4N5P6Q7R8S9T0V1W2", { quantity: 3 });
    await client.agent.getAftersale("AS20260922001");
    await client.agent.getPolicies("warranty");

    expect(requests.map((r) => r.url)).toEqual([
      "https://x/api/v1/agent/orders/DS20260920143000123",
      "https://x/api/v1/agent/orders?userId=01J9Z8K2M4N5P6Q7R8S9T0Z002&limit=5",
      "https://x/api/v1/agent/products/01J9Z8K2M4N5P6Q7R8S9T0V1W2/specs",
      "https://x/api/v1/agent/products/01J9Z8K2M4N5P6Q7R8S9T0V1W2/stock?quantity=3",
      "https://x/api/v1/agent/aftersales/AS20260922001",
      "https://x/api/v1/agent/policies/warranty",
    ]);
    // 六个端点**全部 GET**（`docs/07` §7.8.3 只读保证）
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("Admin 写端点走 POST，并把请求体 JSON 序列化", async () => {
    const { fetch, last } = stubFetch(() =>
      jsonResponse(
        { code: "ERR_ADMIN_TOTP_REQUIRED", message: "该操作需要动态验证码", data: null },
        401,
      ),
    );
    const client = createApiClient({ baseUrl: "https://x", bearerToken: "jwt", fetch });

    await client.admin.issueAgentToken({
      name: "piecho-prod",
      scopes: ["agent:order:read", "agent:product:read"],
      totpCode: "123456",
    });

    const request = last();
    expect(request?.url).toBe("https://x/api/v1/admin/agent-tokens");
    expect(request?.method).toBe("POST");
    expect(request?.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    // `AdminAgentTokenIssueBodySchema` 补默认值（180 天 / 600 次每分钟）
    expect(request?.body).toContain('"expiresInDays":180');
    expect(request?.body).toContain('"rateLimitPerMin":600');
  });
});
