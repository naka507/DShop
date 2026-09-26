/**
 * 任务队列死信运维仓储（`docs/08:111`、`docs/12` §12.8.2）。
 *
 * 列名基准：`packages/db/migrations/0001_init.sql:614-624`。
 * 表结构：
 * `id / type / payload / status / attempts / run_at / last_error / created_at / updated_at`
 *
 * ## 为什么必须有（本文件是缺陷修复的一半）
 *
 * `docs/08:111` 与 `docs/12:317` 都声称 `attempts >= TASK_MAX_ATTEMPTS` 的任务
 * 「置 `failed` **进死信，后台可见可重放**」——但修复前后台**没有任何入口**：
 * 死信只能靠人肉连 D1 改库。本文件提供**读列表 / 读详情 / 重放**三个 SQL 原语，
 * 由 `routes/admin/task-queue.ts` 挂到 `/api/v1/admin/task-queue*`。
 *
 * ## 重放为什么必须写成「单条原子 UPDATE」
 *
 * `replayFailedTask` 把守卫 `status = 'failed'` 写进 **SQL 的 `WHERE`**，而不是
 * 「先 `SELECT` 再 `UPDATE`」：后者在并发下会双双重放同一行（两次读到的都是
 * `failed`），handler 被并行执行两遍。与 `jobs/task-queue.ts` 的
 * `claimPendingTask`（`status = 'pending'` 守卫）是同一条纪律。
 */

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `task_queue` 行（9 列全量，`0001_init.sql:614-624`）。
 *
 * ⚠️ 与 `apps/api/src/jobs/task-queue.ts` 的同名接口**刻意不同**：那个是消费侧
 * 的最小投影（7 列，无 `created_at` / `updated_at`），本文件是运维侧的全列视图。
 */
export interface TaskQueueRow {
  readonly id: string;
  readonly type: string;
  readonly payload: string;
  readonly status: string;
  readonly attempts: number;
  readonly run_at: string;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 列表查询输入（`status` / `type` 为空则不加该过滤条件）。 */
export interface ListTaskQueueInput {
  readonly status?: string;
  readonly type?: string;
  readonly page: number;
  readonly pageSize: number;
}

/** 列表查询结果（`items` 为当前页，`total` 为过滤后的总行数）。 */
export interface ListTaskQueueResult {
  readonly items: TaskQueueRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/* -------------------------------------------------------------------------- */
/* 读                                                                          */
/* -------------------------------------------------------------------------- */

/** 列表查询列（与 {@link TaskQueueRow} 逐列对齐）。 */
const TASK_QUEUE_COLUMNS =
  "id, type, payload, status, attempts, run_at, last_error, created_at, updated_at";

/**
 * 按 `created_at DESC` 分页列出任务行。
 *
 * `total` 与 `items` 用**同一段 `WHERE`**，避免两处条件漂移导致分页错位
 * （与 `repositories/merchant-orders.ts` 的 `listMerchantOrders` 同写法）。
 *
 * ⚠️ `payload` **原样返回字符串**，不做 `JSON.parse`：死信里恰恰会有
 * 「payload 损坏」的行（`jobs/task-queue.ts` 的 `task_payload_invalid`），
 * 在这里解析会让运维入口对最需要被看到的那批行返回 500。
 */
export async function listTaskQueue(
  db: D1Database,
  input: ListTaskQueueInput,
): Promise<ListTaskQueueResult> {
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (input.status !== undefined && input.status.length > 0) {
    conditions.push("status = ?");
    args.push(input.status);
  }
  if (input.type !== undefined && input.type.length > 0) {
    conditions.push("type = ?");
    args.push(input.type);
  }

  const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  const offset = (input.page - 1) * input.pageSize;

  const [countRow, rows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM task_queue${where}`)
      .bind(...args)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT ${TASK_QUEUE_COLUMNS} FROM task_queue${where}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...args, input.pageSize, offset)
      .all<TaskQueueRow>(),
  ]);

  return {
    items: rows.results ?? [],
    total: countRow?.total ?? 0,
    page: input.page,
    pageSize: input.pageSize,
  };
}

/** 按 id 取单行；不存在返回 `null`（调用方回 `ERR_ADMIN_TASK_NOT_FOUND`）。 */
export async function findTaskById(db: D1Database, id: string): Promise<TaskQueueRow | null> {
  return await db
    .prepare(`SELECT ${TASK_QUEUE_COLUMNS} FROM task_queue WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<TaskQueueRow>();
}

/* -------------------------------------------------------------------------- */
/* 写                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 重放一条死信任务：`failed` → `pending`，清零 `attempts`、清空 `last_error`、
 * 把 `run_at` 拉到 `nowIso`（立即到期，下一次 Cron tick 即可被消费）。
 *
 * **单条 SQL 原子更新**：守卫 `status = 'failed'` 在 `WHERE` 里，故并发重放同一行时
 * 只有一次返回 `changes === 1`，其余为 `0`——调用方据此回 409 而**不谎报成功**。
 *
 * @returns 实际被更新的行数（`0` = 该行已不存在或已不是 `failed`）。
 */
export async function replayFailedTask(
  db: D1Database,
  input: { id: string; nowIso: string },
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE task_queue
          SET status = 'pending', attempts = 0, run_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'failed'`,
    )
    .bind(input.nowIso, input.nowIso, input.id)
    .run();
  return Number(result.meta.changes ?? 0);
}
