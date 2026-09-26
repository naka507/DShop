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
 * 生产者在**下单成功后**入队并带上 `delaySeconds = 支付期限剩余秒数`
 * （`apps/api/src/routes/shop/orders.ts`，升级缝 S1 的传输层延迟），
 * 消费方为 {@link handleOrderTimeoutCancel}。其余类型（自动确认收货 / 结算 /
 * 优惠券过期 / 物流轨迹 / 通知）属后续里程碑（`docs/08:105-109`）。
 *
 * ## 关单的正确性保证：传输层延迟 **+** 消费端二次校验
 *
 * 1. **传输层延迟**：生产者按 `pay_deadline` 算 `delaySeconds`，`run_at` / Queues
 *    `delaySeconds` 都据此推迟——这只是**削峰**，不是正确性保证。
 * 2. **消费端二次校验**（真正的保证）：{@link handleOrderTimeoutCancel} 自己读
 *    `orders.pay_deadline`；订单仍是 `PENDING_PAYMENT` 但**未到期**时**绝不关单**，
 *    而是通过 {@link TaskResult} 协议请求**延后到 `pay_deadline`**。时钟漂移、
 *    手工重放、或有人直接 `INSERT` 一行都绕不过这一步。
 *
 * ## 未注册类型：**不参与抢占**（P1-2 槽位饥饿）
 *
 * 可运行集合被限定为 `type IN (<已注册类型>)`（见 {@link consumeTaskQueue}）。
 * 原因：若把本版本不认识的 `pending` 行也选进来，它们会 `continue` 并**保持
 * `pending` 且 `run_at <= now`**，于是**每次都被重选**——累积到 `LIMIT` 上限
 * 就把可运行槽位全部占满，**所有已注册任务（含关单）永远不再执行**。
 * 这直接推翻「删绑定即安全」的承诺，故必须按已注册类型过滤。
 *
 * 未注册行因此**保持 `pending` 不消耗 `attempts`**（既有定案：否则一条本版本
 * 不认识的记录会被无限重试直到进死信，回滚版本后无法处理），改用一条独立的
 * `COUNT(*)` 统计它们并计入 {@link TaskQueueConsumeResult.skipped} + 结构化告警。
 *
 * ## 本 job 的其余职责
 *
 * 1. 把超时的 `processing` 行**重回 `pending`**（幂等重试的前提）；
 * 2. 把 `attempts >= max_attempts` 的行置 `failed`（死信，可人工重放）。
 */

import { TASK_TYPE } from "@dshop/services";
import type { TaskEnvelope } from "@dshop/services";
import type { TaskQueueStatus } from "@dshop/shared";

import {
  cancelUnpaidOrder,
  findOrderStatusById,
  listOrderSkuQuantities,
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

/**
 * handler 结果协议。
 *
 * - `undefined` —— 任务**已完成**（成功）；消费方置 `done` / `ack()`。
 * - `{ deferredUntilMs }` —— 任务**尚未到期**，请**重排到该时刻**；消费方
 *   必须保持 `pending` 并写 `run_at = deferredUntilMs`（Cron 路径），或
 *   `retry({ delaySeconds })`（Queues 路径）——**不得**计入 `succeeded`。
 *
 * 抛错仍表示失败（`attempts + 1`，留 `last_error`）。
 */
export type TaskResult = { readonly deferredUntilMs: number } | undefined;

/** 任务处理函数：抛错即视为失败（attempts +1，留 `last_error`）。 */
export type TaskHandler = (task: TaskQueueRow) => Promise<TaskResult>;

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
 *
 * `createdAtMs` 是**下单时刻**的审计线索（排查「任务比预期早/晚触发」时唯一
 * 可对照的生产端时间戳），handler 侧保留解析与告警上下文。
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
 * - 订单**仍未支付**（`PENDING_PAYMENT`）**且已过 `pay_deadline`** → 关单 + 释放锁定
 *   （`locked_stock -= q`，不动物理 `stock`，`docs/08:105`、`docs/05` §5.3②）；
 * - 订单**仍未支付但未到期**（`Date.parse(pay_deadline) > now`）→ **绝不关单**，
 *   返回 `{ deferredUntilMs: pay_deadline }` 请消费方**重排到该时刻**
 *   （P0-1 的核心：传输层延迟可能被绕过，这里是真正的正确性保证）；
 * - 订单**已支付**（或已取消）→ 返回 `undefined`，**不抛错**（幂等；抛错会让
 *   `consumeTaskQueue` 白白 `attempts + 1` 并最终进死信）。
 *
 * 幂等性由三处保证：
 * 1. {@link cancelUnpaidOrder} 的 batch 内 `WHERE status = 'PENDING_PAYMENT'`
 *    —— 只有真正完成迁移的那一次返回 `true`，其余直接返回；
 * 2. {@link cancelUnpaidOrder} batch 内每条后续语句的 `EXISTS` 守卫
 *    —— 未完成迁移时释放/子单/日志语句全部空转；
 * 3. `releaseSkuStatement` 的 `WHERE locked_stock >= ?`，重复释放不会把锁定扣成负数。
 */
async function handleOrderTimeoutCancel(
  task: TaskQueueRow,
  db: D1Database,
): Promise<TaskResult> {
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
    return undefined;
  }

  // 先读状态只为**短路已支付单**（避免无谓的写）；关单判据仍在 batch 的 WHERE 里。
  const order = await findOrderStatusById(db, payload.orderId);
  if (order === null || order.status !== "PENDING_PAYMENT") return undefined;

  // ★ 二次校验：未到期绝不关单，请求延后到 `pay_deadline`。
  // 这一步是「下单约 1 分钟后就被关单」缺陷的**唯一正确性修复点**：
  // 传输层延迟（`delaySeconds`）只削峰，时钟漂移 / 手工重放 / 直接 INSERT 都能绕过它。
  const deadlineMs = order.pay_deadline === null ? Number.NaN : Date.parse(order.pay_deadline);
  const nowMs = Date.now();
  if (Number.isFinite(deadlineMs) && deadlineMs > nowMs) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "task_deferred_before_deadline",
        taskType: task.type,
        taskId: task.id,
        orderNo: payload.orderNo,
        createdAtMs: payload.createdAtMs,
        deferredUntilMs: deadlineMs,
      }),
    );
    return { deferredUntilMs: deadlineMs };
  }

  const nowIso = new Date(nowMs).toISOString();
  // 先取 SKU 与数量：关单与释放锁定必须落在**同一个** batch 里（P1-1）。
  const items = await listOrderSkuQuantities(db, payload.orderId);
  await cancelUnpaidOrder(db, {
    orderId: payload.orderId,
    nowIso,
    skuQuantities: items.map((item) => ({ skuId: item.sku_id, quantity: item.quantity })),
  });
  // 返回值只用于「本次是否真的完成迁移」；无论 `true` 还是 `false` 都是**成功**语义
  // （`false` = 已被支付/取消/并发抢先，幂等返回，不抛错）。
  return undefined;
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
 * ⚠️ **本表的键集合同时决定 `consumeTaskQueue` 的候选集**（`type IN (...)`）：
 * 未注册类型**不会**被选进可运行集合，避免槽位饥饿（见文件头「未注册类型」）。
 *
 * 目前只注册 {@link TASK_TYPE.ORDER_TIMEOUT_CANCEL}（`docs/08:105`）；
 * 其余类型属后续里程碑（`docs/08:105-109`）。
 */
export function createTaskHandlers(db: D1Database): Readonly<Record<string, TaskHandler>> {
  return {
    [TASK_TYPE.ORDER_TIMEOUT_CANCEL]: (task) => handleOrderTimeoutCancel(task, db),
  };
}

/** {@link executeTaskEnvelope} 的结果。 */
export interface ExecuteTaskEnvelopeResult {
  /** 是否被本版本认识并执行成功（`false` = 未注册类型，调用方应 ack + 告警）。 */
  readonly handled: boolean;
  /** 未到期需重排的时刻（毫秒）；`undefined` = 已完成，无需重排。 */
  readonly deferredUntilMs?: number;
}

/**
 * 执行单个 {@link TaskEnvelope}（Queues 出口 `queue()` 复用本函数）。
 *
 * @returns `{ handled }` —— `false` 表示未注册类型，调用方应 ack + 告警；
 *          `{ handled: true, deferredUntilMs }` 表示任务未到期，调用方应
 *          `retry({ delaySeconds })`（**不要** ack）。
 * @throws handler 抛出的错误原样上抛，调用方据此 `message.retry()`。
 */
export async function executeTaskEnvelope(
  db: D1Database,
  envelope: TaskEnvelope,
): Promise<ExecuteTaskEnvelopeResult> {
  const handler = createTaskHandlers(db)[envelope.type];
  if (handler === undefined) return { handled: false };
  const result = await handler({
    id: `queue:${envelope.type}`,
    type: envelope.type,
    payload: JSON.stringify(envelope.payload),
    status: "processing",
    attempts: 0,
    run_at: new Date().toISOString(),
    last_error: null,
  });
  if (result === undefined) return { handled: true };
  return { handled: true, deferredUntilMs: result.deferredUntilMs };
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
  /** **未到期被重排**的任务数（不计入 `succeeded`）。 */
  readonly deferred: number;
  /** 未注册类型而跳过的行数（**不参与抢占**，见文件头）。 */
  readonly skipped: number;
}

const EMPTY_RESULT: TaskQueueConsumeResult = {
  requeued: 0,
  deadLettered: 0,
  succeeded: 0,
  failed: 0,
  deferred: 0,
  skipped: 0,
};

/** 生成 `?, ?, ...` 占位串（`type IN (...)` 的 bind 参数个数必须动态拼）。 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * 统计「未注册类型」的待办行数（`status = 'pending'` 且已到期）。
 *
 * 这些行**不被选进可运行集合**（避免槽位饥饿，见文件头），故必须单独计数，
 * 否则告警与 `skipped` 指标会永久静默——运维就看不到「本版本不认识的任务在堆积」。
 */
async function countUnregisteredPending(
  db: D1Database,
  registered: readonly string[],
  nowIso: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM task_queue
        WHERE status = 'pending' AND run_at <= ? AND type NOT IN (${placeholders(registered.length)})`,
    )
    .bind(nowIso, ...registered)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * 抢占一条待办：`pending` → `processing`。
 *
 * **必须带 `status = 'pending'` 守卫**：Cron 重叠时两次调用都会 SELECT 到同一行，
 * 守卫让 `meta.changes` 只有一次为 1，另一次返回 `false` 由调用方跳过。
 * 这是「任务不被并行执行」的唯一保证（handler 自身幂等只是第二道防线）。
 */
export async function claimPendingTask(
  db: D1Database,
  id: string,
  nowIso: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE task_queue SET status = 'processing', updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(nowIso, id)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

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

  const handlers = createTaskHandlers(db);
  const registeredTypes = Object.keys(handlers);
  if (registeredTypes.length === 0) {
    return { ...EMPTY_RESULT, requeued, deadLettered };
  }

  // ⚠️ 候选集**限定为已注册类型**：未注册的 `pending` 行保持原样且不占槽位
  // （否则累积到 LIMIT 就会饿死所有已注册任务，见文件头 P1-2）。
  const pending = await db
    .prepare(
      `SELECT id, type, payload, status, attempts, run_at, last_error
         FROM task_queue
        WHERE status = 'pending' AND run_at <= ?
          AND type IN (${placeholders(registeredTypes.length)})
        ORDER BY run_at ASC
        LIMIT ?`,
    )
    .bind(nowIso, ...registeredTypes, TASK_QUEUE_BATCH_SIZE)
    .all<TaskQueueRow>();

  let succeeded = 0;
  let failed = 0;
  let deferred = 0;

  for (const task of pending.results ?? []) {
    const handler = handlers[task.type];
    if (handler === undefined) continue; // 理论上不可达（SQL 已过滤）；防御性跳过

    // 抢占：置 `processing`，**带 `status = 'pending'` 守卫**。
    // Cron 若重叠（同一表达式被并发触发），两次都会 SELECT 到同一行；守卫保证只有
    // 一次抢占成功，另一次直接跳过，避免同一任务被并行执行两遍（非幂等 handler 会重复副作用）。
    const claimed = await claimPendingTask(db, task.id, nowIso);
    if (!claimed) continue;

    try {
      const result = await handler(task);
      if (result !== undefined && result.deferredUntilMs > nowMs) {
        // ★ 未到期：**不置 done**，回到 pending 并把 `run_at` 推到该时刻。
        await db
          .prepare(
            `UPDATE task_queue
                SET status = 'pending', run_at = ?, updated_at = ?
              WHERE id = ?`,
          )
          .bind(new Date(result.deferredUntilMs).toISOString(), nowIso, task.id)
          .run();
        deferred += 1;
        continue;
      }

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

  // 未注册类型单独统计 + 结构化告警（它们**不占槽位**，但必须可见）。
  const skipped = await countUnregisteredPending(db, registeredTypes, nowIso);
  if (skipped > 0) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "task_type_unregistered",
        count: skipped,
        registeredTypes,
      }),
    );
  }

  return { requeued, deadLettered, succeeded, failed, deferred, skipped };
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
