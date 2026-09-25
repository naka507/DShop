/**
 * 账号域（7 表）：`admin_users`、`roles`、`admin_user_roles`、`merchant_members`、
 * `refresh_tokens`、`service_tokens`★、`audit_logs`。
 *
 * 列名基准：`docs/M0-字段契约.md` §2。
 * RBAC 说明：**没有** `permissions` / `role_permissions` / `user_roles` 表，
 * 权限点以 JSON 数组存在 `roles.permissions`（`docs/M0-实施简报.md` §3.3）。
 */

import type {
  AdminUserStatus,
  MerchantMemberRole,
  RoleScope,
  ServiceTokenStatus,
} from "@dshop/shared";
import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** `admin_users` —— 后台账号。 */
export const adminUsers = sqliteTable(
  "admin_users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    /** 格式 `pbkdf2$<alg>$<iter>$<saltB64url>$<dkB64url>`。 */
    passwordHash: text("password_hash").notNull(),
    nickname: text("nickname"),
    /** ⚠️ 文档未定义取值，见 `enums.ts` `ADMIN_USER_STATUS`。 */
    status: text("status").$type<AdminUserStatus>().notNull().default("active"),
    /** Base32，未启用为 NULL。 */
    totpSecret: text("totp_secret"),
    totpEnabled: integer("totp_enabled").notNull().default(0),
    lastLoginAt: text("last_login_at"),
    /** 连续失败 5 次锁定 15 分钟。 */
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: text("locked_until"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_admin_users_username").on(t.username)],
);
/** `roles` —— 内置角色（8 行种子，见 `migrations/0002_seed.sql`）。 */
export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    scope: text("scope").$type<RoleScope>().notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** 权限点 JSON 数组，`NOT NULL DEFAULT '[]'`。 */
    permissions: text("permissions").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_roles_code").on(t.code)],
);

/** `admin_user_roles` —— 后台账号 ↔ 角色。 */
export const adminUserRoles = sqliteTable(
  "admin_user_roles",
  {
    id: text("id").primaryKey(),
    adminUserId: text("admin_user_id").notNull(),
    roleId: text("role_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_admin_user_roles").on(t.adminUserId, t.roleId)],
);

/** `merchant_members` —— 商户成员（行级隔离依据）。 */
export const merchantMembers = sqliteTable(
  "merchant_members",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    adminUserId: text("admin_user_id").notNull(),
    role: text("role").$type<MerchantMemberRole>().notNull(),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_merchant_members").on(t.merchantId, t.adminUserId),
    index("idx_merchant_members_admin").on(t.adminUserId),
  ],
);

/** `refresh_tokens` —— 刷新令牌（支持强制下线）。 */
export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    /** `shop`/`admin`/`merchant`（JWT `aud` 三取值）。 */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    /** SHA-256 hex。 */
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    replacedBy: text("replaced_by"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_refresh_tokens_hash").on(t.tokenHash),
    index("idx_refresh_tokens_subject").on(t.subjectType, t.subjectId),
  ],
);

/** `service_tokens` —— Agent 服务令牌。★ PiEcho 接入凭证。 */
export const serviceTokens = sqliteTable(
  "service_tokens",
  {
    id: text("id").primaryKey(),
    /** `HMAC-SHA256(AGENT_TOKEN_PEPPER, token明文)` hex。 */
    tokenHash: text("token_hash").notNull(),
    /** token 明文**前 16 位**。 */
    tokenPrefix: text("token_prefix").notNull(),
    name: text("name").notNull(),
    /** 4 个读 scope 的 JSON 数组。 */
    scopes: text("scopes").notNull().default("[]"),
    /** 「过期」由 `expires_at` 判定，不单列状态值。 */
    status: text("status").$type<ServiceTokenStatus>().notNull().default("active"),
    /** 默认签发 +180 天。 */
    expiresAt: text("expires_at").notNull(),
    lastUsedAt: text("last_used_at"),
    rateLimitPerMin: integer("rate_limit_per_min").notNull().default(600),
    /** `admin_users.id`。 */
    createdBy: text("created_by").notNull(),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
    /** 轮换时指向旧令牌 id。 */
    rotatedFrom: text("rotated_from"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_service_tokens_hash").on(t.tokenHash),
    index("idx_service_tokens_prefix").on(t.tokenPrefix),
  ],
);

/** `audit_logs` —— 审计日志（后台写操作与令牌管理强制落审计）。 */
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    /** `admin`/`merchant`/`user`/`system`/`agent`。 */
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    before: text("before"),
    after: text("after"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_audit_logs_actor").on(t.actorType, t.actorId, desc(t.createdAt)),
    index("idx_audit_logs_target").on(t.targetType, t.targetId),
  ],
);
