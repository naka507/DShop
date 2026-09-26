/**
 * 错误码分层契约测试（`docs/README.md:34` / `docs/06-API路由命名空间.md:20`）。
 *
 * 规定原文：
 * > **错误码**：Agent 组用**整数**码；shop/admin/merchant 用字符串码。
 * > `ORDER_STOCK_NOT_ENOUGH` 一类字符串错误码**仅用于 shop / admin / merchant 三组**，
 * > 两组不混用。
 *
 * 本文件锁定的是**真实的缺陷**：改造前
 * - `apps/api/src/routes/admin/index.ts` 返回整数 `40101`（Agent 码）
 * - `apps/api/src/index.ts` 的全局 404 对**所有**路径返回整数 `40401`
 *
 * 因此除了正向断言（agent → 整数、admin → 字符串），还必须有
 * **负向控制**：断言 admin 路径**不再**返回整数码。
 *
 * 策略：走真实生产入口 `../src/index.js`（`docs` 契约测试的既定纪律：
 * 不自建中间件链），D1 用最小内存 fake。
 *
 * ## Agent 组的「防探测」姿态（**本文件的一条独立契约**）
 *
 * `apps/api/src/routes/agent/index.ts:54` 的 `agentRoutes.use("*", serviceTokenAuth())`
 * 覆盖整个 `/api/v1/agent` 前缀，因此**未认证**请求会先被鉴成 `401`（整数 `40101`），
 * **而不是** 404——这是有意的防探测设计：不向未认证方泄露「某路径是否存在」。
 * 只有带**合法令牌**时才会走到 404 兜底并拿到整数 `40401`。
 *
 * 故本文件用两条断言把这个行为**双向固定**：
 * - 无令牌 → `401` + 整数码（不泄露路径存在性）；
 * - 有令牌 → `404` + 整数 `40401`（错误码分层对 Agent 组仍成立）。
 */

import { generateServiceToken, hashServiceToken, serviceTokenPrefix } from "@dshop/auth";
import { ADMIN_ERROR_CODES, AGENT_ERROR_CODES } from "@dshop/shared";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import app from "../src/index.js";

/** 测试用**合法**服务令牌：格式与校验位由 `@dshop/auth` 生成，必然通过格式预检。 */
const SERVICE_TOKEN = generateServiceToken();
/** 与 `createEnv()` 的 `AGENT_TOKEN_PEPPER` 保持一致。 */
const TOKEN_PEPPER = "test-pepper";

/**
 * 内存 fake D1。
 *
 * `service_tokens` 查询返回一条 `active` 令牌行（哈希按同一 pepper 现算），
 * 使「带合法令牌」的用例能**穿过鉴权**走到 404 兜底；其余查询一律空结果。
 */
class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly args: readonly unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    if (
      this.sql.includes("FROM service_tokens") &&
      this.args[0] === serviceTokenPrefix(SERVICE_TOKEN)
    ) {
      return {
        id: "01J9Z8K2M4N5P6Q7R8S9T0T001",
        token_hash: await hashServiceToken(TOKEN_PEPPER, SERVICE_TOKEN),
        token_prefix: serviceTokenPrefix(SERVICE_TOKEN),
        name: "error-codes-test",
        scopes: JSON.stringify(["agent:order:read"]),
        status: "active",
        expires_at: "2099-01-01T00:00:00.000Z",
        rate_limit_per_min: 600,
      } as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return { results: [], success: true, meta: { duration: 0 } };
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    return { success: true, meta: { changes: 0 } };
  }
}

function createFakeDb(): D1Database {
  return {
    prepare: (sql: string) => new FakeStatement(sql),
    batch: async () => [],
  } as unknown as D1Database;
}

function createEnv(): Env {
  return {
    DB: createFakeDb(),
    AGENT_TOKEN_PEPPER: TOKEN_PEPPER,
    PHONE_ENC_KEY: "phone-enc-key",
    PHONE_HASH_PEPPER: "phone-hash-pepper",
    JWT_SECRET: "jwt-secret",
    ENVIRONMENT: "test",
  };
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/**
 * 以真实入口发起请求。
 *
 * @param withServiceToken 为 `true` 时带合法 `X-Service-Token`（穿过 Agent 鉴权）
 */
async function call(path: string, method = "GET", withServiceToken = false): Promise<Response> {
  const headers: Record<string, string> = {
    "X-Contract-Version": "1",
  };
  if (withServiceToken) headers["X-Service-Token"] = SERVICE_TOKEN;

  return await app.request(path, { method, headers }, createEnv(), executionCtx);
}

interface Envelope {
  readonly code: unknown;
  readonly message: string;
  readonly data: unknown;
}

describe("错误码分层：Agent 组（整数码）", () => {
  it("未知 agent 路径（带合法令牌）→ 404 且 code 为整数 40401", async () => {
    const res = await call("/api/v1/agent/no-such-endpoint", "GET", true);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("number");
    expect(body.code).toBe(AGENT_ERROR_CODES.ORDER_NOT_FOUND);
  });

  it("未知 agent 路径（**无**令牌）→ 401 且为整数码：不泄露路径是否存在", async () => {
    const res = await call("/api/v1/agent/no-such-endpoint");
    // 防探测：鉴权先于路由匹配，故未认证方拿不到「404 = 该路径不存在」的信息
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("number");
    expect(body.code).toBe(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID);
  });

  it("缺令牌的真实 agent 端点仍返回整数 40101（未被字符串码污染）", async () => {
    const res = await call("/api/v1/agent/orders/DS20260920143000123");
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("number");
    expect(body.code).toBe(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID);
  });
});

describe("错误码分层：后台组（字符串码）", () => {
  it("未知 admin 路径 → 404 且 code 为字符串 ERR_ADMIN_NOT_FOUND", async () => {
    const res = await call("/api/v1/admin/no-such-endpoint");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("string");
    expect(body.code).toBe(ADMIN_ERROR_CODES.NOT_FOUND);
  });

  it("admin 未登录 → 401 且 code 为字符串 ERR_ADMIN_TOKEN_MISSING", async () => {
    const res = await call("/api/v1/admin/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("string");
    expect(body.code).toBe(ADMIN_ERROR_CODES.TOKEN_MISSING);
  });

  it("admin 登录失败（账号不存在）→ 401 且 code 为字符串 ERR_ADMIN_TOKEN_INVALID", async () => {
    const res = await app.request(
      "/api/v1/admin/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Contract-Version": "1" },
        body: JSON.stringify({ username: "nobody", password: "whatever" }),
      },
      createEnv(),
      executionCtx,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope;
    expect(typeof body.code).toBe("string");
    expect(body.code).toBe(ADMIN_ERROR_CODES.TOKEN_INVALID);
  });

  it("shop / merchant 组各自返回本域字符串码", async () => {
    const shop = await call("/api/v1/shop/no-such-endpoint");
    expect(shop.status).toBe(404);
    const shopBody = (await shop.json()) as Envelope;
    expect(shopBody.code).toBe("ERR_SHOP_NOT_FOUND");

    const merchant = await call("/api/v1/merchant/no-such-endpoint");
    expect(merchant.status).toBe(404);
    const merchantBody = (await merchant.json()) as Envelope;
    expect(merchantBody.code).toBe("ERR_MERCHANT_NOT_FOUND");
  });
});

/**
 * **负向控制**：没有这组断言，改造可能只是「多加了一个字符串码分支」，
 * 而整数码仍在后台路径上返回——契约违规依旧。
 */
describe("负向控制：后台路径**不再**返回整数码", () => {
  const ADMIN_PATHS = [
    "/api/v1/admin/no-such-endpoint",
    "/api/v1/admin/me",
    "/api/v1/admin/login",
    "/api/v1/admin/agent-tokens",
  ];

  for (const path of ADMIN_PATHS) {
    it(`${path} 的 code 不是 number（旧实现为 40401 / 40101 / 50001）`, async () => {
      const res = await call(path, path === "/api/v1/admin/login" ? "POST" : "GET");
      const body = (await res.json()) as Envelope;
      expect(typeof body.code).not.toBe("number");
      // 并且不得是任何 Agent 整数码的字面值
      expect(Object.values(AGENT_ERROR_CODES)).not.toContain(body.code);
    });
  }

  it("后台字符串码与 Agent 整数码值域完全不重叠", () => {
    const backofficeValues: string[] = Object.values(ADMIN_ERROR_CODES);
    for (const value of backofficeValues) {
      expect(value.startsWith("ERR_ADMIN_")).toBe(true);
    }
    // 负向：整数码里不存在任何字符串值
    for (const value of Object.values(AGENT_ERROR_CODES)) {
      expect(typeof value).toBe("number");
    }
  });
});
