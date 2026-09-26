/**
 * 服务令牌仓储（`docs/07` §7.8.1 / `docs/05` `service_tokens` 表）。
 *
 * 认证流程（**常量时间、无早退泄漏**）：
 * 1. 从 `X-Service-Token` 头取明文令牌
 * 2. 校验格式（`dshop_svc_<24位>_<6位校验位>`），格式不符直接 401
 * 3. 取明文前 16 位作为 `token_prefix`，**先按 prefix 索引查行**（避免全表扫）
 * 4. 对候选行重算 `HMAC-SHA256(pepper, token明文)` 并常量时间比对
 * 5. 校验 `status = active` 且 `expires_at` 未过；通过则异步更新 `last_used_at`
 *
 * 注意：`token_prefix` 只是**查询加速**，不是安全边界——真正的比对在步骤 4。
 */

import { hashServiceToken, serviceTokenPrefix, verifyServiceToken } from "@dshop/auth";
import { AGENT_SCOPE } from "@dshop/shared";
import type { AgentScope } from "@dshop/shared";

/** `service_tokens` 行（脱敏后；**不含 token_hash 的对外暴露**）。 */
export interface ServiceTokenRecord {
  readonly id: string;
  readonly tokenPrefix: string;
  readonly name: string;
  readonly scopes: readonly AgentScope[];
  readonly status: string;
  readonly expiresAt: string;
  readonly rateLimitPerMin: number;
}

interface ServiceTokenRow {
  readonly id: string;
  readonly token_hash: string;
  readonly token_prefix: string;
  readonly name: string;
  readonly scopes: string;
  readonly status: string;
  readonly expires_at: string;
  readonly rate_limit_per_min: number;
}

/** 令牌校验失败的原因（用于区分 401 与 401/吊销）。 */
export type TokenFailure = "not_found" | "revoked" | "expired";

export interface TokenLookupResult {
  readonly ok: boolean;
  readonly token?: ServiceTokenRecord;
  readonly failure?: TokenFailure;
}

function parseScopes(raw: string): AgentScope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = new Set<string>(Object.values(AGENT_SCOPE));
    return parsed.filter((s): s is AgentScope => typeof s === "string" && valid.has(s));
  } catch {
    return [];
  }
}

/**
 * 按明文令牌查库并校验。
 *
 * @param db D1 绑定
 * @param pepper `AGENT_TOKEN_PEPPER`
 * @param token 明文令牌（`X-Service-Token` 头的值）
 * @param nowMs 当前时间（可注入便于测试）
 */
export async function authenticateServiceToken(
  db: D1Database,
  pepper: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<TokenLookupResult> {
  const prefix = serviceTokenPrefix(token);

  const row = await db
    .prepare(
      `SELECT id, token_hash, token_prefix, name, scopes, status, expires_at, rate_limit_per_min
         FROM service_tokens
        WHERE token_prefix = ?
        LIMIT 1`,
    )
    .bind(prefix)
    .first<ServiceTokenRow>();

  if (row === null) return { ok: false, failure: "not_found" };

  // 常量时间比对（真正的安全边界）
  const match = await verifyServiceToken(pepper, token, row.token_hash);
  if (!match) return { ok: false, failure: "not_found" };

  if (row.status !== "active") return { ok: false, failure: "revoked" };

  const expiresAtMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
    return { ok: false, failure: "expired" };
  }

  return {
    ok: true,
    token: {
      id: row.id,
      tokenPrefix: row.token_prefix,
      name: row.name,
      scopes: parseScopes(row.scopes),
      status: row.status,
      expiresAt: row.expires_at,
      rateLimitPerMin: row.rate_limit_per_min,
    },
  };
}

/** 更新 `last_used_at`（异步、失败不阻断请求）。 */
export async function touchServiceToken(
  db: D1Database,
  tokenId: string,
  nowIso: string,
): Promise<void> {
  try {
    await db
      .prepare(`UPDATE service_tokens SET last_used_at = ? WHERE id = ?`)
      .bind(nowIso, tokenId)
      .run();
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "touch_service_token_failed",
        tokenId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** 计算令牌哈希（供签发脚本使用）。 */
export { hashServiceToken };

/* -------------------------------------------------------------------------- */
/* 签发 / 吊销（后台运营入口，`docs/09` §9.2 / `docs/06:37-38`）                 */
/* -------------------------------------------------------------------------- */

/** 签发输入（明文令牌由调用方生成，本层只落库哈希与前缀）。 */
export interface IssueServiceTokenInput {
  readonly id: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly rateLimitPerMin: number;
  /** 签发人（`admin_users.id`），落 `created_by`。 */
  readonly createdBy: string;
  /** 轮换来源令牌 id；首次签发为 `null`。 */
  readonly rotatedFrom?: string | null;
  readonly createdAt: string;
}

/**
 * 落库一条服务令牌（`packages/db/migrations/0001_init.sql:120-136` 的列名）。
 *
 * ⚠️ **只存哈希**（`HMAC-SHA256(pepper, token)` hex）；明文由调用方在响应里返回一次。
 */
export async function insertServiceToken(
  db: D1Database,
  input: IssueServiceTokenInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO service_tokens
         (id, token_hash, token_prefix, name, scopes, status, expires_at, last_used_at,
          rate_limit_per_min, created_by, revoked_at, revoked_by, rotated_from,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.tokenHash,
      input.tokenPrefix,
      input.name,
      JSON.stringify(input.scopes),
      input.expiresAt,
      input.rateLimitPerMin,
      input.createdBy,
      input.rotatedFrom ?? null,
      input.createdAt,
      input.createdAt,
    )
    .run();
}

/** 后台视角的令牌行（`token_hash` 绝不出库到路由层）。 */
export interface ServiceTokenAdminRow {
  readonly id: string;
  readonly name: string;
  readonly token_prefix: string;
  readonly status: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly rate_limit_per_min: number;
}

/** 按 id 取令牌（后台吊销用）。 */
export async function findServiceTokenById(
  db: D1Database,
  id: string,
): Promise<ServiceTokenAdminRow | null> {
  return await db
    .prepare(
      `SELECT id, name, token_prefix, status, expires_at, revoked_at, rate_limit_per_min
         FROM service_tokens
        WHERE id = ?
        LIMIT 1`,
    )
    .bind(id)
    .first<ServiceTokenAdminRow>();
}

/**
 * 吊销令牌（`status = 'revoked'` + `revoked_at` / `revoked_by`）。
 *
 * 立即生效：`authenticateServiceToken` 每次请求都查库并校验 `status`
 * （`docs/09` §9.1：不透明令牌的选择理由就是「可立即吊销」）。
 */
export async function revokeServiceToken(
  db: D1Database,
  id: string,
  revokedBy: string,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE service_tokens
          SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(nowIso, revokedBy, nowIso, id)
    .run();
}
