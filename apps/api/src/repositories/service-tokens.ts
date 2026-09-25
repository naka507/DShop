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
