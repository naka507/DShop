/**
 * 审计日志仓储（`docs/09` §9.2：「后台所有写操作落 `audit_logs`（谁、何时、对什么、改了什么）」）。
 *
 * 列名基准：`packages/db/migrations/0001_init.sql:140-152`。
 * 表结构：
 * `id / actor_type / actor_id / action / target_type / target_id / before / after / ip / user_agent / created_at`
 */

import { newId } from "@dshop/shared";

/** `audit_logs.actor_type` 取值（`docs/M0-字段契约.md:121`）。 */
export const AUDIT_ACTOR_TYPE = {
  ADMIN: "admin",
  MERCHANT: "merchant",
  USER: "user",
  SYSTEM: "system",
  AGENT: "agent",
} as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPE)[keyof typeof AUDIT_ACTOR_TYPE];

/** 审计条目（`before` / `after` 为任意 JSON 可序列化值）。 */
export interface AuditLogEntry {
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
}

/** `before` / `after` 序列化：`undefined` / `null` 存 `NULL`，其余存 JSON 文本。 */
function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    // 循环引用等异常值：不因审计内容不可序列化而阻断写路径
    return null;
  }
}

/**
 * 写一条审计日志。
 *
 * ⚠️ 与业务写操作**同事务语义**由调用方决定：本函数直接 `await`，
 * 抛错即向上传播（审计是写操作的一部分，不像 Agent 审计那样可丢弃）。
 */
export async function insertAuditLog(db: D1Database, entry: AuditLogEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs
         (id, actor_type, actor_id, action, target_type, target_id, before, after,
          ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      entry.actorType,
      entry.actorId,
      entry.action,
      entry.targetType,
      entry.targetId,
      serialize(entry.before),
      serialize(entry.after),
      entry.ip,
      entry.userAgent,
      entry.createdAt,
    )
    .run();
}
