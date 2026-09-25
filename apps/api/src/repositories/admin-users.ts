/**
 * 后台账号仓储（`docs/09` §9.1 登录与会话）。
 *
 * 覆盖 `admin_users` / `roles` / `admin_user_roles` / `merchant_members` /
 * `refresh_tokens` 五张表的读写。
 */

import type { JwtAudience } from "@dshop/shared";

/** 后台账号行（**含 `password_hash`，仅限认证流程内部使用**）。 */
export interface AdminUserRow {
  readonly id: string;
  readonly username: string;
  readonly password_hash: string;
  readonly nickname: string | null;
  readonly status: string;
  readonly totp_secret: string | null;
  readonly totp_enabled: number;
  readonly failed_attempts: number;
  readonly locked_until: string | null;
}

/** 认证成功后对外返回的主体信息（**不含任何凭据**）。 */
export interface AdminIdentity {
  readonly id: string;
  readonly username: string;
  readonly nickname: string | null;
  readonly roleCodes: readonly string[];
  readonly permissions: readonly string[];
  readonly merchantIds: readonly string[];
}

export async function findAdminUserByUsername(
  db: D1Database,
  username: string,
): Promise<AdminUserRow | null> {
  return await db
    .prepare(
      `SELECT id, username, password_hash, nickname, status, totp_secret,
              totp_enabled, failed_attempts, locked_until
         FROM admin_users
        WHERE username = ?
        LIMIT 1`,
    )
    .bind(username)
    .first<AdminUserRow>();
}

export async function findAdminUserById(
  db: D1Database,
  id: string,
): Promise<AdminUserRow | null> {
  return await db
    .prepare(
      `SELECT id, username, password_hash, nickname, status, totp_secret,
              totp_enabled, failed_attempts, locked_until
         FROM admin_users
        WHERE id = ?
        LIMIT 1`,
    )
    .bind(id)
    .first<AdminUserRow>();
}

/** 取该账号的全部角色 code。 */
export async function findRoleCodesForAdmin(
  db: D1Database,
  adminUserId: string,
): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT r.code AS code
         FROM admin_user_roles aur
         JOIN roles r ON r.id = aur.role_id
        WHERE aur.admin_user_id = ?`,
    )
    .bind(adminUserId)
    .all<{ code: string }>();
  return (res.results ?? []).map((r) => r.code);
}

/** 取该账号的全部权限点（由 `roles.permissions` json 数组合并去重）。 */
export async function findPermissionsForAdmin(
  db: D1Database,
  adminUserId: string,
): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT r.permissions AS permissions
         FROM admin_user_roles aur
         JOIN roles r ON r.id = aur.role_id
        WHERE aur.admin_user_id = ?`,
    )
    .bind(adminUserId)
    .all<{ permissions: string }>();

  const set = new Set<string>();
  for (const row of res.results ?? []) {
    try {
      const parsed: unknown = JSON.parse(row.permissions);
      if (Array.isArray(parsed)) {
        for (const p of parsed) if (typeof p === "string") set.add(p);
      }
    } catch {
      // 脏数据忽略，不影响其余角色
    }
  }
  return [...set];
}

/** 取该账号关联的商户 id 列表（商户侧行级隔离的依据）。 */
export async function findMerchantIdsForAdmin(
  db: D1Database,
  adminUserId: string,
): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT merchant_id AS merchantId
         FROM merchant_members
        WHERE admin_user_id = ? AND status = 'active'`,
    )
    .bind(adminUserId)
    .all<{ merchantId: string }>();
  return (res.results ?? []).map((r) => r.merchantId);
}

/** 组装对外身份。 */
export async function loadAdminIdentity(
  db: D1Database,
  user: AdminUserRow,
): Promise<AdminIdentity> {
  const [roleCodes, permissions, merchantIds] = await Promise.all([
    findRoleCodesForAdmin(db, user.id),
    findPermissionsForAdmin(db, user.id),
    findMerchantIdsForAdmin(db, user.id),
  ]);
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    roleCodes,
    permissions,
    merchantIds,
  };
}

/**
 * 登录失败计数 +1；达到 5 次锁定 15 分钟（`docs/09` §9.1）。
 *
 * ⚠️ 阈值与锁定时长为**实现侧定案**（文档只说「连续失败锁定」，未给数值）。
 */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_DURATION_MINUTES = 15;

export async function recordLoginFailure(
  db: D1Database,
  user: AdminUserRow,
  nowMs: number,
): Promise<void> {
  const attempts = user.failed_attempts + 1;
  const lockUntil =
    attempts >= MAX_FAILED_ATTEMPTS
      ? new Date(nowMs + LOCK_DURATION_MINUTES * 60_000).toISOString()
      : null;
  await db
    .prepare(
      `UPDATE admin_users
          SET failed_attempts = ?, locked_until = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(attempts, lockUntil, new Date(nowMs).toISOString(), user.id)
    .run();
}

/** 登录成功：清零失败计数、记录 `last_login_at`。 */
export async function recordLoginSuccess(
  db: D1Database,
  adminUserId: string,
  nowMs: number,
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  await db
    .prepare(
      `UPDATE admin_users
          SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(nowIso, nowIso, adminUserId)
    .run();
}

/* -------------------------------------------------------------------------- */
/* 刷新令牌                                                                    */
/* -------------------------------------------------------------------------- */

export async function insertRefreshToken(
  db: D1Database,
  input: {
    id: string;
    subjectType: JwtAudience;
    subjectId: string;
    tokenHash: string;
    expiresAt: string;
    userAgent: string | null;
    ip: string | null;
    createdAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO refresh_tokens
         (id, subject_type, subject_id, token_hash, expires_at, revoked_at,
          replaced_by, user_agent, ip, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.subjectType,
      input.subjectId,
      input.tokenHash,
      input.expiresAt,
      input.userAgent,
      input.ip,
      input.createdAt,
    )
    .run();
}

export interface RefreshTokenRow {
  readonly id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly token_hash: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly replaced_by: string | null;
}

export async function findRefreshTokenByHash(
  db: D1Database,
  tokenHash: string,
): Promise<RefreshTokenRow | null> {
  return await db
    .prepare(
      `SELECT id, subject_type, subject_id, token_hash, expires_at, revoked_at, replaced_by
         FROM refresh_tokens
        WHERE token_hash = ?
        LIMIT 1`,
    )
    .bind(tokenHash)
    .first<RefreshTokenRow>();
}

/** 旋转：把旧令牌标记为已吊销并指向新令牌（`docs/09` §9.1 旋转式刷新）。 */
export async function revokeRefreshToken(
  db: D1Database,
  tokenId: string,
  replacedBy: string | null,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE refresh_tokens
          SET revoked_at = ?, replaced_by = ?
        WHERE id = ?`,
    )
    .bind(nowIso, replacedBy, tokenId)
    .run();
}
