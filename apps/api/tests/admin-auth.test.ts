/**
 * 后台登录 / 刷新 Cookie 契约测试（`docs/09` §9.1）。
 *
 * 覆盖的真实缺陷：`POST /api/v1/admin/refresh` 曾只重设 refresh Cookie，
 * 不重设 access Cookie（`dshop_admin_at`），导致客户端拿到新 refresh 后
 * access Cookie 仍是旧/过期值，登录态无法续期。
 *
 * 策略（与 `agent-contract.test.ts` 一致）：
 * - **不连真 D1**：内存 fake 实现最小 `D1Database` 接口，按 SQL 模式分发；
 *   与契约测试不同，这里 `run()` 会**真实落库**（INSERT/UPDATE），
 *   否则无法验证 refresh 旋转与旧令牌吊销。
 * - **走真实生产入口**：`import app from "../src/index.js"`，即 `src/index.ts`
 *   的装配，**不自建中间件链**。
 */

import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  hashPassword,
  hashRefreshToken,
} from "@dshop/auth";
import { ADMIN_ERROR_CODES } from "@dshop/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env.js";
import app from "../src/index.js";

/* -------------------------------------------------------------------------- */
/* 固定数据                                                                     */
/* -------------------------------------------------------------------------- */

const ADMIN_ID = "01J9Z8K2M4N5P6Q7R8S9T0A001";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "secret-password";
const ROLE_ID = "01J9Z8K2M4N5P6Q7R8S9T0B001";
const ROLE_CODE = "platform_operator";

/** 固定的合法 refresh 明文（43 字符 base64url，满足 `REFRESH_TOKEN_REGEX`）。 */
const OLD_REFRESH = "A".repeat(43);

const ADMIN_ACCESS_COOKIE = "dshop_admin_at";
const ADMIN_REFRESH_COOKIE = "dshop_admin_rt";

type Row = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* 内存 D1 fake                                                                 */
/* -------------------------------------------------------------------------- */

const adminUsers: Row[] = [];
const roles: Row[] = [];
const adminUserRoles: Row[] = [];
const merchantMembers: Row[] = [];
const refreshTokens: Row[] = [];

let adminPasswordHash = "";
let oldRefreshHash = "";

function seedAdminUser(): void {
  adminUsers.length = 0;
  adminUsers.push({
    id: ADMIN_ID,
    username: ADMIN_USERNAME,
    password_hash: adminPasswordHash,
    nickname: "平台管理员",
    status: "active",
    totp_secret: null,
    totp_enabled: 0,
    failed_attempts: 0,
    locked_until: null,
  });
}

function seedRefreshToken(): void {
  refreshTokens.length = 0;
  refreshTokens.push({
    id: "01J9Z8K2M4N5P6Q7R8S9T0C001",
    subject_type: "admin",
    subject_id: ADMIN_ID,
    token_hash: oldRefreshHash,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    revoked_at: null,
    replaced_by: null,
  });
}

function query(sql: string, args: readonly unknown[]): Row[] {
  // --- admin_users ---
  if (sql.includes("FROM admin_users") && sql.includes("WHERE username = ?")) {
    return adminUsers.filter((r) => r.username === args[0]);
  }
  if (sql.includes("FROM admin_users") && sql.includes("WHERE id = ?")) {
    return adminUsers.filter((r) => r.id === args[0]);
  }

  // --- 角色 / 权限 / 商户成员 ---
  if (sql.includes("SELECT r.code AS code")) {
    const roleIds = adminUserRoles.filter((r) => r.admin_user_id === args[0]).map((r) => r.role_id);
    return roles.filter((r) => roleIds.includes(r.id));
  }
  if (sql.includes("SELECT r.permissions AS permissions")) {
    const roleIds = adminUserRoles.filter((r) => r.admin_user_id === args[0]).map((r) => r.role_id);
    return roles.filter((r) => roleIds.includes(r.id));
  }
  if (sql.includes("FROM merchant_members")) {
    return merchantMembers.filter((r) => r.admin_user_id === args[0] && r.status === "active");
  }

  // --- refresh_tokens ---
  if (sql.includes("FROM refresh_tokens")) {
    return refreshTokens.filter((r) => r.token_hash === args[0]);
  }

  return [];
}

/** `run()` 的真实落库：只处理刷新令牌的 INSERT / UPDATE。 */
function applyMutation(sql: string, args: readonly unknown[]): void {
  if (sql.includes("UPDATE refresh_tokens")) {
    const [revokedAt, replacedBy, tokenId] = args;
    const row = refreshTokens.find((r) => r.id === tokenId);
    if (row !== undefined) {
      row.revoked_at = revokedAt ?? null;
      row.replaced_by = replacedBy ?? null;
    }
    return;
  }
  if (sql.includes("INSERT INTO refresh_tokens")) {
    const [id, subjectType, subjectId, tokenHash, expiresAt, userAgent, ip, createdAt] = args;
    refreshTokens.push({
      id,
      subject_type: subjectType,
      subject_id: subjectId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      revoked_at: null,
      replaced_by: null,
      user_agent: userAgent ?? null,
      ip: ip ?? null,
      created_at: createdAt,
    });
  }
}

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly args: readonly unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    const rows = query(this.sql, this.args);
    return (rows[0] ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return {
      results: query(this.sql, this.args) as T[],
      success: true,
      meta: { duration: 0 },
    };
  }

  async run(): Promise<{ success: true; meta: Record<string, unknown> }> {
    applyMutation(this.sql, this.args);
    return { success: true, meta: { changes: 1 } };
  }
}

/**
 * 内存 fake D1。
 *
 * `batch()` 供 `agentAudit` 落库（`agent_call_logs`）使用
 * （`apps/api/src/middleware/agent-audit.ts:170`）：语义对齐真实 D1，
 * 同一事务内按序执行并返回各语句结果数组。本文件不校验审计内容。
 */
function createFakeDb(): D1Database {
  return {
    prepare: (sql: string) => new FakeStatement(sql),
    batch: async (statements: readonly unknown[]) =>
      statements.map(() => ({ success: true, meta: { changes: 1 } })),
  } as unknown as D1Database;
}

/** 假限流 DO：恒放行（后台路由不触发，仅为满足 `Env` 形状）。 */
function createFakeRateLimiter(): DurableObjectNamespace {
  const stub = {
    fetch: async () => Response.json({ allowed: true, count: 1, limit: 120, remaining: 119 }),
  };
  return {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

/**
 * `ENVIRONMENT: "test"`（≠ `development`）→ Cookie 应带 `Secure`。
 * 与生产入口一致地走 `src/index.ts` 的装配。
 */
function createEnv(): Env {
  return {
    DB: createFakeDb(),
    AGENT_RATE_LIMITER: createFakeRateLimiter(),
    AGENT_TOKEN_PEPPER: "test-pepper",
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

/* -------------------------------------------------------------------------- */
/* 请求辅助                                                                     */
/* -------------------------------------------------------------------------- */

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly cookie?: string;
}

async function call(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "X-Contract-Version": "1" };
  if (options.cookie !== undefined) headers["Cookie"] = options.cookie;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(
    path,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    createEnv(),
    executionCtx,
  );
}

/** 取全部 `Set-Cookie`（Node 22 / workerd 的 `Headers#getSetCookie`）。 */
function getSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw === null ? [] : [raw];
}

/** 从 `Set-Cookie` 数组里取出某个 Cookie 名对应的完整串。 */
function findCookie(cookies: readonly string[], name: string): string | undefined {
  return cookies.find((c) => c.startsWith(`${name}=`));
}

/** 取 Cookie 的原始值（第一个 `=` 之后到 `;` 之前）。 */
function cookieValue(cookie: string): string {
  const eq = cookie.indexOf("=");
  const semi = cookie.indexOf(";", eq);
  return cookie.slice(eq + 1, semi === -1 ? undefined : semi);
}

/* -------------------------------------------------------------------------- */
/* 生命周期                                                                     */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
  oldRefreshHash = await hashRefreshToken(OLD_REFRESH);
});

beforeEach(() => {
  seedAdminUser();
  seedRefreshToken();
  roles.length = 0;
  roles.push({
    id: ROLE_ID,
    scope: "platform",
    code: ROLE_CODE,
    name: "平台运营",
    permissions: JSON.stringify(["admin:user:read"]),
  });
  adminUserRoles.length = 0;
  adminUserRoles.push({ id: "aur-1", admin_user_id: ADMIN_ID, role_id: ROLE_ID });
  merchantMembers.length = 0;
});

/* -------------------------------------------------------------------------- */
/* 1. /refresh 必须同时下发 access + refresh 两个 Cookie                        */
/* -------------------------------------------------------------------------- */

describe("POST /api/v1/admin/refresh 的 Cookie", () => {
  it("成功响应同时带 access 与 refresh 两个 Set-Cookie", async () => {
    const res = await call("/api/v1/admin/refresh", {
      method: "POST",
      cookie: `${ADMIN_REFRESH_COOKIE}=${OLD_REFRESH}`,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { refreshToken: string } };
    expect(body.code).toBe(0);

    const cookies = getSetCookies(res);
    const accessCookie = findCookie(cookies, ADMIN_ACCESS_COOKIE);
    const refreshCookie = findCookie(cookies, ADMIN_REFRESH_COOKIE);

    // 这是缺陷的核心断言：以前这里 accessCookie 为 undefined
    expect(accessCookie, "缺少 access Cookie 即登录态无法续期").toBeDefined();
    expect(refreshCookie).toBeDefined();

    // refresh Cookie 的值应等于响应体里的新令牌
    expect(cookieValue(refreshCookie!)).toBe(body.data.refreshToken);
  });

  it("两个 Cookie 均为 HttpOnly + SameSite=Lax + Path=/，Secure（ENVIRONMENT≠development）", async () => {
    const res = await call("/api/v1/admin/refresh", {
      method: "POST",
      cookie: `${ADMIN_REFRESH_COOKIE}=${OLD_REFRESH}`,
    });
    const cookies = getSetCookies(res);

    for (const name of [ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE]) {
      const cookie = findCookie(cookies, name);
      expect(cookie, `${name} 缺失`).toBeDefined();
      expect(cookie!).toContain("HttpOnly");
      expect(cookie!).toContain("SameSite=Lax");
      expect(cookie!).toContain("Path=/");
      expect(cookie!).toContain("Secure");
    }

    // Max-Age 与 TTL 常量一致
    expect(findCookie(cookies, ADMIN_ACCESS_COOKIE)!).toContain(
      `Max-Age=${ACCESS_TOKEN_TTL_SECONDS}`,
    );
    expect(findCookie(cookies, ADMIN_REFRESH_COOKIE)!).toContain(
      `Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`,
    );
  });

  it("刷新后的 access Cookie 是**可用**令牌：可访问 GET /admin/me", async () => {
    const res = await call("/api/v1/admin/refresh", {
      method: "POST",
      cookie: `${ADMIN_REFRESH_COOKIE}=${OLD_REFRESH}`,
    });
    const accessCookie = findCookie(getSetCookies(res), ADMIN_ACCESS_COOKIE);
    expect(accessCookie).toBeDefined();

    const me = await call("/api/v1/admin/me", {
      cookie: `${ADMIN_ACCESS_COOKIE}=${cookieValue(accessCookie!)}`,
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { code: number; data: { id: string; role: string } };
    expect(meBody.code).toBe(0);
    expect(meBody.data.id).toBe(ADMIN_ID);
    expect(meBody.data.role).toBe(ROLE_CODE);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. refresh 旋转语义未变                                                       */
/* -------------------------------------------------------------------------- */

describe("refresh 旋转与吊销语义", () => {
  it("旋转后旧 refresh 令牌失效（revoked_at 置位 + replaced_by 指向新行）", async () => {
    const first = await call("/api/v1/admin/refresh", {
      method: "POST",
      cookie: `${ADMIN_REFRESH_COOKIE}=${OLD_REFRESH}`,
    });
    expect(first.status).toBe(200);
    const newToken = ((await first.json()) as { data: { refreshToken: string } }).data.refreshToken;

    // 旧行已吊销，且 replaced_by 指向新行
    const oldRow = refreshTokens.find((r) => r.token_hash === oldRefreshHash);
    expect(oldRow).toBeDefined();
    expect(oldRow!.revoked_at).not.toBeNull();
    expect(oldRow!.replaced_by).not.toBeNull();
    expect(refreshTokens.some((r) => r.id === oldRow!.replaced_by)).toBe(true);

    // 新行落库，且与新 Cookie 值哈希一致
    const newHash = await hashRefreshToken(newToken);
    expect(refreshTokens.some((r) => r.token_hash === newHash)).toBe(true);

    // 用旧令牌再刷 → 401 + ERR_ADMIN_TOKEN_REVOKED（已吊销）
    // ⚠️ 错误码为**字符串**：`docs/README.md:34`「Agent 组用整数码；shop/admin/merchant 用字符串码」
    const second = await call("/api/v1/admin/refresh", {
      method: "POST",
      cookie: `${ADMIN_REFRESH_COOKIE}=${OLD_REFRESH}`,
    });
    expect(second.status).toBe(401);
    expect(((await second.json()) as { code: string }).code).toBe(ADMIN_ERROR_CODES.TOKEN_REVOKED);
  });

  it("缺少 refresh Cookie → 401 + ERR_ADMIN_TOKEN_MISSING（字符串码，非整数 40101）", async () => {
    const res = await call("/api/v1/admin/refresh", { method: "POST" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: unknown };
    expect(body.code).toBe(ADMIN_ERROR_CODES.TOKEN_MISSING);
    // 负向控制：不得再返回 Agent 组的整数码
    expect(typeof body.code).toBe("string");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. /login 与 /refresh 的 Cookie 属性一致                                      */
/* -------------------------------------------------------------------------- */

describe("/login 与 /refresh 的 Cookie 构造一致", () => {
  it("/login 同时下发两个 Cookie，属性与 /refresh 相同", async () => {
    const login = await call("/api/v1/admin/login", {
      method: "POST",
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    expect(login.status).toBe(200);
    const loginCookies = getSetCookies(login);

    const loginAccess = findCookie(loginCookies, ADMIN_ACCESS_COOKIE);
    const loginRefresh = findCookie(loginCookies, ADMIN_REFRESH_COOKIE);
    expect(loginAccess).toBeDefined();
    expect(loginRefresh).toBeDefined();

    const refreshRes = await call("/api/v1/admin/refresh", {
      method: "POST",
      cookie: `${ADMIN_REFRESH_COOKIE}=${cookieValue(loginRefresh!)}`,
    });
    const refreshCookies = getSetCookies(refreshRes);

    // 去掉 Cookie 值，只比较属性串（名称 + 属性应逐字一致）
    const attributesOf = (cookie: string): string => cookie.slice(cookie.indexOf(";")).trim();
    expect(attributesOf(findCookie(refreshCookies, ADMIN_ACCESS_COOKIE)!)).toBe(
      attributesOf(loginAccess!),
    );
    expect(attributesOf(findCookie(refreshCookies, ADMIN_REFRESH_COOKIE)!)).toBe(
      attributesOf(loginRefresh!),
    );
  });
});
