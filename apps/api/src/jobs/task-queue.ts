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

import { TASK_MAX_ATTEMPTS, TASK_TYPE } from "@dshop/services";
import type { TaskEnvelope } from "@dshop/services";
import { ORDER_PAY_TIMEOUT_MINUTES } from "@dshop/shared";
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

/**
 * 最大尝试次数；达到即置 `failed`（死信）。
 *
 * ★ P2#1：**直接复用** `@dshop/services` 的 {@link TASK_MAX_ATTEMPTS}，
 * 不再在本文件另立一个「同值常量」。历史上这里曾有 `TASK_QUEUE_MAX_ATTEMPTS = 5`
 * 与 services 侧 `TASK_MAX_ATTEMPTS = 5` 两个常量：它们靠注释声明「同值」而**无任何
 * 测试锁定**，任一侧改动都会让「默认实现与升级目标对齐」的承诺静默失效
 * （`packages/services/src/task-queue.ts:14-19` 的纪律一）。
 * 现在只有一个来源，漂移在**编译期**就不可能发生。
 */
export { TASK_MAX_ATTEMPTS };

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
 * - `{ failed: true, reason }` —— 任务**确定性地无法完成**（不可重试：重投只会
 *   重复失败）。消费方置 `failed` 并写 `last_error = reason`，计入 `failed`
 *   （**不**计入 `succeeded`）；Queues 路径 **`ack()` + 告警**（不 retry）。
 *   典型场景：payload 解析失败、`pay_deadline` 与兜底期限都不可用（P1-B 第二兜底）。
 *
 * 抛错仍表示**可重试失败**（`attempts + 1`，留 `last_error`，有界退避）。
 */
export type TaskResult =
  | { readonly deferredUntilMs: number }
  | { readonly failed: true; readonly reason: string }
  | undefined;

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
 * 可对照的生产端时间戳）；★ P1-B 起它还承担 `pay_deadline` 不可用时的
 * **兜底期限**判据（见 {@link resolvePayDeadline}）。
 */
export interface OrderTimeoutCancelPayload {
  /** 主单 id（关单与释放锁定的定位键）。 */
  readonly orderId: string;
  /** 主单号（仅日志与排查用）。 */
  readonly orderNo: string;
  /** 下单时刻（毫秒时间戳）。 */
  readonly createdAtMs: number;
}

/** 解析 payload；缺关键字段返回 `null`（视为不可处理，置 `failed`）。 */
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

/** 支付期限（毫秒）的来源，用于结构化告警（审计「为什么用这个判据」）。 */
type PayDeadlineSource = "pay_deadline" | "createdAtMs";

/** 解析出的支付期限（含来源）；`null` = 两处都不可用。 */
interface ResolvedPayDeadline {
  readonly deadlineMs: number;
  readonly source: PayDeadlineSource;
}

/**
 * ★ P1-B：两级兜底解析「订单的支付截止时刻」。
 *
 * `orders.pay_deadline` 在 DDL 里**可空**（`packages/db/migrations/0001_init.sql:306`
 * 的 `CREATE TABLE orders` 中 `pay_deadline TEXT`，无 `NOT NULL`），且它是 TEXT，
 * 完全可能是非法串（人工改库 / 老数据 / 序列化 bug）。此时
 * `Date.parse` 返回 `NaN`，而 `Number.isFinite(NaN) === false` 会让旧的
 * 「未到期则延后」判断**被跳过** → **立刻关单**，与 P0-1 同症状但方向相反：
 * P0-1 的整个意义是「**宁可晚关**」，旧写法却变成「宁可错关」。
 *
 * 故：
 * 1. **第一兜底**：`pay_deadline` 不可用时，用 payload 的 `createdAtMs`
 *    （下单时刻，生产者必写）推 `createdAtMs + ORDER_PAY_TIMEOUT_MINUTES * 60_000`。
 *    它有限时即可作为判据（`source: "createdAtMs"`），与正常路径走**同一套**延后逻辑。
 * 2. **第二兜底**：两处都不可用 → 返回 `null`，调用方**绝不关单**，把任务置 `failed`
 *    交人工介入（见 {@link TaskResult}）。
 *
 * 注意：**绝不**把「未知期限」当作「已过期」——那正是本缺陷的根因。
 */
function resolvePayDeadline(
  payDeadline: string | null,
  createdAtMs: number,
  nowMs: number,
): ResolvedPayDeadline | null {
  if (payDeadline !== null) {
    const deadlineMs = Date.parse(payDeadline);
    if (Number.isFinite(deadlineMs)) return { deadlineMs, source: "pay_deadline" };
  }
  // ★ 合理性窗口（对抗性复核 P2#4）：兜底源 `createdAtMs` 来自 **payload**（可被篡改/写坏），
  // 若它是 `0`、负数或远在未来，`createdAtMs + 15min` 会落在 1970 或遥远未来 —— 前者
  // 会「立即关单」（与 P1-B「宁可晚关」相反），后者会让锁定被永久占用。
  // 因此只在 `createdAtMs` 落在 `(0, now]` 时才采纳；否则视为不可用 → 走 `failed`。
  if (Number.isFinite(createdAtMs) && createdAtMs > 0 && createdAtMs <= nowMs) {
    return {
      deadlineMs: createdAtMs + ORDER_PAY_TIMEOUT_MINUTES * 60_000,
      source: "createdAtMs",
    };
  }
  return null;
}

/**
 * 回收**超时**的 `processing` 行：置回 `pending` 并**累加 `attempts`**。
 *
 * ⚠️ 为什么要累加（对抗性复核 P1#7）：`processing` 超时的真实成因是 isolate 被回收
 * ——此时 handler **从未返回**、`catch` 也**从未进入**，所以 `attempts` 永远是 0，
 * `deadLetterExhaustedTasks` 的 `attempts >= TASK_MAX_ATTEMPTS` 永不触发 →
 * **毒任务每 5 分钟被无限回收重试，永不进死信**，与「自愈 + 死信」的叙事冲突。
 * 累加后毒任务终将进入死信，交人工介入。
 */
async function requeueStuckTasks(
  db: D1Database,
  timeoutIso: string,
  nowIso: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE task_queue
          SET status = 'pending', attempts = attempts + 1, updated_at = ?
        WHERE status = 'processing' AND updated_at <= ?`,
    )
    .bind(nowIso, timeoutIso)
    .run();
  return result.meta.changes ?? 0;
}
/**
 * 超时未支付关单（`docs/08:105`）。
 *
 * 语义（`docs/08:54-56` 状态机）：
 * - 订单**仍未支付**（`PENDING_PAYMENT`）**且已过支付期限** → 关单 + 释放锁定
 *   （`locked_stock -= q`，不动物理 `stock`，`docs/08:105`、`docs/05` §5.3②）；
 * - 订单**仍未支付但未到期** → **绝不关单**，返回 `{ deferredUntilMs }` 请消费方
 *   **重排到该时刻**（P0-1 的核心：传输层延迟可能被绕过，这里是真正的正确性保证）；
 *   ★ P1-B：期限优先取 `pay_deadline`，不可用（`NULL` / 非法串）时取
 *   `createdAtMs + ORDER_PAY_TIMEOUT_MINUTES`（见 {@link resolvePayDeadline}）；
 * - 订单**已支付**（或已取消）→ 返回 `undefined`，**不抛错**（幂等；抛错会让
 *   `consumeTaskQueue` 白白 `attempts + 1` 并最终进死信）；
 * - 支付期限**两处都不可用** → 返回 `{ failed: true, reason }`：**绝不关单**，
 *   把任务置 `failed` 交人工介入（P1-B 第二兜底）；
 * - payload 无法解析 → 同上置 `failed`（P2#3：不可重试的解析错误）。
 *
 * 幂等性由三处保证：
 * 1. {@link cancelUnpaidOrder} 的 batch 内**末条**语句的 `WHERE status = 'PENDING_PAYMENT'`
 *    —— 只有真正完成迁移的那一次返回 `true`，其余直接返回；
 * 2. {@link cancelUnpaidOrder} batch 内**前序**语句的 `EXISTS` 守卫
 *    （守卫条件同样是「订单此刻仍是 `PENDING_PAYMENT`」）——未完成迁移时
 *    释放 / 子单 / 日志语句全部空转（P1-A：**不用** `cancelled_at` 匹配）；
 * 3. `releaseSkuStatement` 的 `WHERE locked_stock >= ?`，重复释放不会把锁定扣成负数。
 */
async function handleOrderTimeoutCancel(
  task: TaskQueueRow,
  db: D1Database,
): Promise<TaskResult> {
  const payload = parseTimeoutPayload(task.payload);
  if (payload === null) {
    // ★ P2#3：payload 损坏是**不可重试**的解析错误——重投多少次都不会变好。
    // 旧实现置 `done`（当成功静默丢弃）→ 订单**永不关单**且无人知晓；
    // 现在置 `failed` + 结构化告警，让它在死信里**可见**。
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "task_payload_invalid",
        taskType: task.type,
        taskId: task.id,
      }),
    );
    return { failed: true, reason: "task_payload_invalid" };
  }

  // 先读状态只为**短路已支付单**（避免无谓的写）；关单判据仍在 batch 的 WHERE 里。
  const order = await findOrderStatusById(db, payload.orderId);
  if (order === null || order.status !== "PENDING_PAYMENT") return undefined;

  // ★ 二次校验：未到期绝不关单，请求延后到支付期限。
  // 这一步是「下单约 1 分钟后就被关单」缺陷的**唯一正确性修复点**：
  // 传输层延迟（`delaySeconds`）只削峰，时钟漂移 / 手工重放 / 直接 INSERT 都能绕过它。
  const nowMs = Date.now();
  const resolved = resolvePayDeadline(order.pay_deadline, payload.createdAtMs, nowMs);
  if (resolved === null) {
    // ★ P1-B 第二兜底：期限**完全不可知** → **绝不关单**（不把「未知」当「已过期」），
    // 置 `failed` 交人工介入。也不能「无限 pending」：重排到一个猜出来的时刻
    // 等于把不确定性变成静默错关。
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "task_pay_deadline_unresolvable",
        taskType: task.type,
        taskId: task.id,
        orderId: payload.orderId,
        orderNo: payload.orderNo,
      }),
    );
    return { failed: true, reason: "task_pay_deadline_unresolvable" };
  }

  if (resolved.deadlineMs > nowMs) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "task_deferred_before_deadline",
        taskType: task.type,
        taskId: task.id,
        orderNo: payload.orderNo,
        createdAtMs: payload.createdAtMs,
        // ★ P1-B：标明本次判据的来源（`pay_deadline` 还是兜底的 `createdAtMs`），
        // 否则「为什么用这个期限」在日志里无法审计。
        deadlineSource: resolved.source,
        deferredUntilMs: resolved.deadlineMs,
      }),
    );
    return { deferredUntilMs: resolved.deadlineMs };
  }

  const nowIso = new Date(nowMs).toISOString();
  // 先取 SKU 与数量：关单与释放锁定必须落在**同一个** batch 里（P1-1）。
  const items = await listOrderSkuQuantities(db, payload.orderId);
  const outcome = await cancelUnpaidOrder(db, {
    orderId: payload.orderId,
    nowIso,
    skuQuantities: items.map((item) => ({ skuId: item.sku_id, quantity: item.quantity })),
  });
  // ★ 释放条数可见性（对抗性复核 P2#6）：`migrated` 只说明订单行迁移成功，
  // 释放语句可能因空数组或 `locked_stock >= ?` 守卫一条都没生效。这种「关单成功
  // 但锁定未释放」若只靠返回值 `true` 是**不可见**的，故在此告警。
  if (outcome.migrated && outcome.released !== outcome.requested) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "order_cancel_stock_release_mismatch",
        orderId: payload.orderId,
        orderNo: payload.orderNo,
        requested: outcome.requested,
        released: outcome.released,
      }),
    );
  }
  // 无论 `migrated` 为真或假都是**成功**语义：`false` = 已被支付/取消/并发抢先，
  // 幂等返回，不抛错（`docs/08:105`）。
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
  /** 是否被本版本认识（`false` = 未注册类型，调用方应 ack + 告警）。 */
  readonly handled: boolean;
  /** 未到期需重排的时刻（毫秒）；`undefined` = 无需重排。 */
  readonly deferredUntilMs?: number;
  /**
   * ★ P1-B：handler 判定「**不可重试**的确定性失败」（如期限不可解析）。
   * `true` 时调用方应 `ack()` + 告警——**不** retry（重投只会重复失败），
   * 否则会耗尽 `max_retries` 并（无 DLQ 时）丢消息。
   */
  readonly failed?: true;
  /** {@link failed} 为 `true` 时的原因（告警用）。 */
  readonly reason?: string;
}

/**
 * 执行单个 {@link TaskEnvelope}（Queues 出口 `queue()` 复用本函数）。
 *
 * @returns `{ handled }` —— `false` 表示未注册类型，调用方应 ack + 告警；
 *          `{ handled: true, deferredUntilMs }` 表示任务未到期，调用方应
 *          `retry({ delaySeconds })`（**不要** ack）；
 *          `{ handled: true, failed: true, reason }` 表示**不可重试**的失败，
 *          调用方应 `ack()` + 告警（**不要** retry）。
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
  if ("failed" in result) {
    return { handled: true, failed: true, reason: result.reason };
  }
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

      // ★ P1-B：**不可重试**的确定性失败（如期限不可解析）→ 置 `failed` + `last_error`。
      // 计入 `failed`（**不**计入 `succeeded`），也不重排（重投只会重复失败）。
      if (result !== undefined && "failed" in result) {
        await db
          .prepare(
            `UPDATE task_queue
                SET status = 'failed', last_error = ?, updated_at = ?
              WHERE id = ?`,
          )
          .bind(result.reason.slice(0, 500), nowIso, task.id)
          .run();
        failed += 1;
        continue;
      }

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
        attempts >= TASK_MAX_ATTEMPTS ? "failed" : "pending";
      // ★ P2#2：失败时**推进 `run_at`**（有界退避），否则「按 `run_at` 退避重试」
      // 只是注释里的承诺——实际是每分钟硬重试到第 5 次。
      const nextRunAtIso = new Date(
        nowMs + retryBackoffSeconds(attempts) * 1000,
      ).toISOString();
      await db
        .prepare(
          `UPDATE task_queue
              SET status = ?, attempts = ?, run_at = ?, last_error = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(nextStatus, attempts, nextRunAtIso, message.slice(0, 500), nowIso, task.id)
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

/** `attempts >= max_attempts` 的 `pending`/`processing` → `failed`（死信，可重放）。 */
async function deadLetterExhaustedTasks(db: D1Database, nowIso: string): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE task_queue
          SET status = 'failed', updated_at = ?
        WHERE attempts >= ? AND status IN ('pending', 'processing')`,
    )
    .bind(nowIso, TASK_MAX_ATTEMPTS)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * ★ P2#2：失败重试的**有界退避**（秒）——`min(60 * 2^(attempts-1), 3600)`。
 *
 * 与 `packages/services/src/task-queue.ts:45` 注释宣称的「按 `run_at` 退避重试」
 * 对齐：`attempts = 1` → 60s，`2` → 120s，`3` → 240s，`4` → 480s，
 * 之后封顶 3600s（1 小时），避免指数爆炸把 `run_at` 推到远古。
 *
 * ⚠️ 修复前失败**不推进 `run_at`**，于是「退避」只是注释里的承诺：实际是
 * 每分钟（Cron tick）硬重试，第 5 次即进死信——一条瞬时故障（如 D1 抖动）
 * 会在 5 分钟内耗尽全部尝试次数。
 */
function retryBackoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** (attempts - 1), 3600);
}
