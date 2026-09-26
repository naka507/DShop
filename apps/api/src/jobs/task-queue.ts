/**
 * `task_queue` 消费 job（`docs/08-核心业务流程.md:43,111`）。
 *
 * 权威依据（`docs/08:111`）：
 * > `task_queue 消费 | Cron 每分钟 | 按类型分发，单次最多 N=50 条；`
 * > `processing` 超时重回 `pending`（幂等），`attempts >= max_attempts` 置 `failed` 进死信可重放
 *
 * ## 升级缝 S1（`docs/04` §4.3 / `docs/12` §12.9.3）
 *
 * 默认实现 = **D1 任务表 + Cron 轮询**；升级 = Cloudflare Queues。
 * 绑定存在性驱动：加 `TASK_QUEUE` 绑定后由 Queue 消费者接手
 * （`apps/api/src/index.ts` 的 `queue()` 出口复用本文件的 {@link executeTaskEnvelope}），
 * 本 job 在无待办时是空操作。**删绑定即回滚**。
 *
 * ## 当前已注册的任务类型
 *
 * {@link TASK_TYPE.ORDER_TIMEOUT_CANCEL}（超时未支付关单，`docs/08:105`）：
 * 生产者在**下单成功后**入队（`apps/api/src/routes/shop/orders.ts`），
 * 消费方为 {@link handleOrderTimeoutCancel}。其余类型（自动确认收货 / 结算 /
 * 优惠券过期 / 物流轨迹 / 通知）属后续里程碑（`docs/08:105-109`），
 * 未注册类型保持 `pending` 并告警。
 *
 * ## 本 job 的其余职责
 *
 * 1. 把超时的 `processing` 行**重回 `pending`**（幂等重试的前提）；
 * 2. 把 `attempts >= max_attempts` 的行置 `failed`（死信，可人工重放）。
 *
 * ⚠️ 未注册类型**不消耗 attempts**：否则一条本版本不认识的记录会被无限重试
 * 直到进死信，回滚版本后无法处理。这属实现侧定案。
 */

import { TASK_TYPE } from "@dshop/services";
import type { TaskEnvelope } from "@dshop/services";
import type { TaskQueueStatus } from "@dshop/shared";

import {
  cancelUnpaidOrder,
  findOrderStatusById,
  listOrderSkuQuantities,
  releaseSkuStocks,
} from "../repositories/shop-orders.js";

/** 单次消费上限（`docs/08:111`：N=50）。 */
export const TASK_QUEUE_BATCH_SIZE = 50;

/** `processing` 超时阈值（毫秒）：超过即视为崩溃遗留，重回 `pending`。 */
export const TASK_QUEUE_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

/** 最大尝试次数；达到即置 `failed`（死信）。 */
export const TASK_QUEUE_MAX_ATTEMPTS = 5;

/** `task_queue` 行（列名对齐 `0001_init.sql:614-624`）。 */
export interface TaskQueueRow {
  readonly id: string;
  readonly type: string;
  readonly payload: string;
  readonly status: TaskQueueStatus;
  readonly attempts: number;
  readonly run_at: string;
  readonly last_error: string | null;
}

/** 任务处理函数：抛错即视为失败（attempts +1，留 `last_error`）。 */
export type TaskHandler = (task: TaskQueueRow) => Promise<void>;

/* -------------------------------------------------------------------------- */
/* 超时未支付关单 handler（`docs/08:105`）                                       */
/* -------------------------------------------------------------------------- */

/**
 * `order.timeout_cancel` 的 payload（**最小信息**：仅够 handler 定位订单）。
 *
 * ⚠️ **刻意不含任何隐私字段**（手机号 / 地址 / 收件人）：`task_queue.payload`
 * 是明文列，而本仓有 `packages/services/src/mask.ts` 的隐私纪律——
 * 消费者要的信息（主单 id / 订单号 / 下单时刻）在 `orders` / `order_items` 里
 * 都能按 id 取到，没有理由把 PII 复制一份进队列表。
 */
export interface OrderTimeoutCancelPayload {
  /** 主单 id（关单与释放锁定的定位键）。 */
  readonly orderId: string;
  /** 主单号（仅日志与排查用）。 */
  readonly orderNo: string;
  /** 下单时刻（毫秒时间戳）。 */
  readonly createdAtMs: number;
}

/** 解析 payload；缺关键字段返回 `null`（视为不可处理，直接跳过）。 */
function parseTimeoutPayload(payload: string): OrderTimeoutCancelPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.orderId !== "string" || record.orderId.length === 0) return null;
  if (typeof record.orderNo !== "string") return null;
  if (typeof record.createdAtMs !== "number") return null;
  return {
    orderId: record.orderId,
    orderNo: record.orderNo,
    createdAtMs: record.createdAtMs,
  };
}

/**
 * 超时未支付关单（`docs/08:105`）。
 *
 * 语义（`docs/08:54-56` 状态机）：
 * - 订单**仍未支付**（`PENDING_PAYMENT`）→ 关单 + **只释放锁定库存**
 *   （`locked_stock -= q`，不动物理 `stock`，`docs/08:105`、`docs/05` §5.3②）；
 * - 订单**已支付**（或已取消）→ **直接返回，不抛错**（幂等；抛错会让
 *   `consumeTaskQueue` 白白 `attempts + 1` 并最终进死信）。
 *
 * 幂等性由两处保证：
 * 1. {@link cancelUnpaidOrder} 的单语句原子更新（`WHERE status = 'PENDING_PAYMENT'`）
 *    —— 只有真正完成迁移的那一次返回 `true`，其余直接返回；
 * 2. `releaseSkuStocks` 走 `WHERE locked_stock >= ?`，重复释放不会把锁定扣成负数。
 */
async function handleOrderTimeoutCancel(task: TaskQueueRow, db: D1Database): Promise<void> {
  const payload = parseTimeoutPayload(task.payload);
  if (payload === null) {
    // payload 损坏：重试也不会变好，直接当成功（消费方置 done），仅告警留痕。
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "task_payload_invalid",
        taskType: task.type,
        taskId: task.id,
      }),
    );
    return;
  }

  // 先读状态只为**短路已支付单**（避免无谓的写）；关单判据仍在 UPDATE 的 WHERE 里。
  const order = await findOrderStatusById(db, payload.orderId);
  if (order === null || order.status !== "PENDING_PAYMENT") return;

  const nowIso = new Date().toISOString();
  const cancelled = await cancelUnpaidOrder(db, { orderId: payload.orderId, nowIso });
  if (!cancelled) return; // 并发下已被他人关单/支付：幂等返回

  const items = await listOrderSkuQuantities(db, payload.orderId);
  await releaseSkuStocks(
    db,
    items.map((item) => ({ skuId: item.sku_id, quantity: item.quantity })),
  );
}

/**
 * 构造「任务类型 → 处理器」注册表（**单一分发表**）。
 *
 * 需要 `db` 是因为 handler 要执行写路径（关单 + 释放锁定）；写路径永远走主库
 * `env.DB`（`packages/services/src/read-db.ts` 的只读纪律）。
 *
 * ⚠️ **Cron 轮询（{@link consumeTaskQueue}）与 Queues 出口
 * （`apps/api/src/index.ts` 的 `queue()`）共用本表**，禁止各写一份分发逻辑——
 * 否则默认实现与升级实现会漂移（`docs/12` §12.9.4 第 3 条）。
 *
 * 目前只注册 {@link TASK_TYPE.ORDER_TIMEOUT_CANCEL}（`docs/08:105`）；
 * 其余类型属后续里程碑（`docs/08:105-109`），未注册类型保持 `pending` 并告警。
 */
export function createTaskHandlers(db: D1Database): Readonly<Record<string, TaskHandler>> {
  return {
    [TASK_TYPE.ORDER_TIMEOUT_CANCEL]: (task) => handleOrderTimeoutCancel(task, db),
  };
}

/**
 * 执行单个 {@link TaskEnvelope}（Queues 出口 `queue()` 复用本函数）。
 *
 * @returns 是否被本版本认识并执行成功（`false` = 未注册类型，调用方应 ack + 告警）。
 * @throws handler 抛出的错误原样上抛，调用方据此 `message.retry()`。
 */
export async function executeTaskEnvelope(
  db: D1Database,
  envelope: TaskEnvelope,
): Promise<boolean> {
  const handler = createTaskHandlers(db)[envelope.type];
  if (handler === undefined) return false;
  await handler({
    id: `queue:${envelope.type}`,
    type: envelope.type,
    payload: JSON.stringify(envelope.payload),
    status: "processing",
    attempts: 0,
    run_at: new Date().toISOString(),
    last_error: null,
  });
  return true;
}

/** 消费结果（供 Cron 日志与测试断言）。 */
export interface TaskQueueConsumeResult {
  /** 重回 `pending` 的超时 `processing` 行数。 */
  readonly requeued: number;
  /** 置 `failed` 的死信行数。 */
  readonly deadLettered: number;
  /** 实际执行成功数。 */
  readonly succeeded: number;
  /** 执行失败（attempts +1）数。 */
  readonly failed: number;
  /** 未注册类型而跳过的行数。 */
  readonly skipped: number;
}

const EMPTY_RESULT: TaskQueueConsumeResult = {
  requeued: 0,
  deadLettered: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
};

/**
 * 消费一批 `task_queue` 待办。
 *
 * 全流程**不抛错**：单个任务失败只影响该行（记 `last_error`、`attempts +1`），
 * Cron 层不因此中断（`docs/08:111` 的死信语义）。
 */
export async function consumeTaskQueue(
  db: D1Database,
  nowMs: number = Date.now(),
): Promise<TaskQueueConsumeResult> {
  const nowIso = new Date(nowMs).toISOString();
  const timeoutIso = new Date(nowMs - TASK_QUEUE_PROCESSING_TIMEOUT_MS).toISOString();

  const requeued = await requeueStuckTasks(db, timeoutIso, nowIso);
  const deadLettered = await deadLetterExhaustedTasks(db, nowIso);

  const pending = await db
    .prepare(
      `SELECT id, type, payload, status, attempts, run_at, last_error
         FROM task_queue
        WHERE status = 'pending' AND run_at <= ?
        ORDER BY run_at ASC
        LIMIT ?`,
    )
    .bind(nowIso, TASK_QUEUE_BATCH_SIZE)
    .all<TaskQueueRow>();

  const handlers = createTaskHandlers(db);
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const task of pending.results ?? []) {
    const handler = handlers[task.type];
    if (handler === undefined) {
      // 未注册类型：保持 pending，不消耗 attempts（见文件头「未注册类型」说明）
      skipped += 1;
      continue;
    }

    // 抢占：置 processing（幂等前提是 handler 自身可重入）
    await db
      .prepare(`UPDATE task_queue SET status = 'processing', updated_at = ? WHERE id = ?`)
      .bind(nowIso, task.id)
      .run();

    try {
      await handler(task);
      await db
        .prepare(
          `UPDATE task_queue
              SET status = 'done', last_error = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .bind(nowIso, task.id)
        .run();
      succeeded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = task.attempts + 1;
      const nextStatus: TaskQueueStatus =
        attempts >= TASK_QUEUE_MAX_ATTEMPTS ? "failed" : "pending";
      await db
        .prepare(
          `UPDATE task_queue
              SET status = ?, attempts = ?, last_error = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(nextStatus, attempts, message.slice(0, 500), nowIso, task.id)
        .run();
      failed += 1;
    }
  }

  return { requeued, deadLettered, succeeded, failed, skipped };
}

/** 超时 `processing` → 重回 `pending`（幂等重试）。 */
async function requeueStuckTasks(
  db: D1Database,
  timeoutIso: string,
  nowIso: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE task_queue
          SET status = 'pending', updated_at = ?
        WHERE status = 'processing' AND updated_at <= ?`,
    )
    .bind(nowIso, timeoutIso)
    .run();
  return result.meta.changes ?? 0;
}

/** `attempts >= max_attempts` 的 `pending`/`processing` → `failed`（死信，可重放）。 */
async function deadLetterExhaustedTasks(db: D1Database, nowIso: string): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE task_queue
          SET status = 'failed', updated_at = ?
        WHERE attempts >= ? AND status IN ('pending', 'processing')`,
    )
    .bind(nowIso, TASK_QUEUE_MAX_ATTEMPTS)
    .run();
  return result.meta.changes ?? 0;
}

export { EMPTY_RESULT as EMPTY_TASK_QUEUE_RESULT };
