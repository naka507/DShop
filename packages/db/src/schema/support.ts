/**
 * 支撑域（3 表）：`task_queue`、`settings`、`agent_call_logs`★。
 *
 * 列名基准：`docs/M0-字段契约.md` §10。
 * 注意 `settings` 主键是 `key`，**无 `id` 列**。
 */

import type { TaskQueueStatus } from "@dshop/shared";
import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** `task_queue` —— 异步任务队列。 */
export const taskQueue = sqliteTable(
  "task_queue",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payload: text("payload").notNull().default("{}"),
    status: text("status").$type<TaskQueueStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAt: text("run_at").notNull(),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_task_queue_status").on(t.status, t.runAt)],
);

/** `settings` —— 平台参数 KV（**主键为 `key`，无 `id`**）。 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  description: text("description"),
  updatedAt: text("updated_at").notNull(),
});

/** `agent_call_logs` —— Agent 调用审计。★ SLO 与 S10/S11 阈值的数据源。 */
export const agentCallLogs = sqliteTable(
  "agent_call_logs",
  {
    id: text("id").primaryKey(),
    tokenId: text("token_id").notNull(),
    path: text("path").notNull(),
    method: text("method").notNull().default("GET"),
    paramsHash: text("params_hash"),
    /** HTTP 状态码。 */
    status: integer("status").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    cacheHit: integer("cache_hit").notNull().default(0),
    contractVersion: text("contract_version"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_agent_logs_token_time").on(t.tokenId, desc(t.createdAt))],
);
