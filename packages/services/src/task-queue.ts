/**
 * S1 异步任务升级缝（`docs/04` §4.3 S1、`docs/12` §12.9.3–§12.9.4、`docs/08` §8.6）。
 *
 * ## 缝的形态
 *
 * | 绑定状态 | 实现 | 语义 |
 * | --- | --- | --- |
 * | `env.TASK_QUEUE` **缺省** | {@link D1TaskQueue} | 写 `task_queue` 表，由 Cron 每分钟轮询消费（`docs/08` §8.6 末行）。零配置、免费层可用。 |
 * | `env.TASK_QUEUE` **存在** | {@link QueuesTaskQueue} | `env.TASK_QUEUE.send(...)`，Cloudflare Queues 原生重试/退避/死信。 |
 *
 * **开关方式**：在 `apps/api/wrangler.jsonc` 增删 `queues` 绑定，业务代码零改动；
 * **删绑定即回滚**到 D1 默认实现（`docs/12` §12.9.4 第 1 条）。
 *
 * ## 纪律一：默认实现语义必须与升级目标对齐（`docs/12` §12.9.4 第 2 条）
 *
 * 默认实现的重试/退避/死信/幂等**按 Queues 的能力设计**，切换后**不补逻辑、不迁数据**：
 * - 重试：`attempts` 自增（消费方负责），失败即回到可重试状态，
 *   **`run_at = now + min(60 * 2^(attempts-1), 3600)` 秒**（有界退避，
 *   见 `apps/api/src/jobs/task-queue.ts` 的 `retryBackoffSeconds`）——
 *   与 Queues 的原生退避语义对齐；
 * - 死信：`attempts` 达到上限（{@link TASK_MAX_ATTEMPTS}）后置 `failed`，可人工重放；
 * - 幂等：任务体自带 `type` + `payload`，消费方必须可重入。
 *
 * ⚠️ **列名以实际迁移为准**（`packages/db/migrations/0001_init.sql` 的 `task_queue`、
 * `packages/db/src/schema/support.ts` 的 `taskQueue`）：
 * 表里只有 `attempts` 与 `run_at`，**没有** `max_attempts` / `next_run_at` 两列。
 * 因此「最大尝试次数」在代码里是常量 {@link TASK_MAX_ATTEMPTS}，
 * `apps/api/src/jobs/task-queue.ts` **直接复用**它（`export { TASK_MAX_ATTEMPTS }`
 * 再导出，不再另立同值常量——重复常量靠注释声明「同值」而无可执行的锁定，
 * 任一侧改动都会让「对齐升级目标」静默失效），
 * 「下次可运行时间」就是 `run_at`。`apps/api/src/env.ts` 注释里写的
 * `max_attempts` / `next_run_at` 属**注释措辞偏差**，本实现按实际列名，绝不臆造列。
 */

import { newId } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 任务类型                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 任务类型取值集合（`docs/08` §8.6 表格逐行对应）。
 *
 * ⚠️ `docs/08` §8.6 **未定义类型字符串的取值**（只定义了任务名），
 * 故取值由实现侧定案并登记：统一 `<域>.<动作>` 小写点分形式。
 * `apps/api/src/jobs/task-queue.ts` 的类型分发表当前为空（M0 未注册业务任务），
 * 后续里程碑注册 handler 时**必须**从本常量取值，禁止散落字面量。
 */
export const TASK_TYPE = {
  /** 通知发送（支付成功 / 发货 / 售后进度），失败按 `run_at` 退避重试。 */
  NOTIFY_SEND: "notify.send",
  /** 超时未支付关单：仅释放锁定（`locked_stock -= q`）。 */
  ORDER_TIMEOUT_CANCEL: "order.timeout_cancel",
  /** 自动确认收货（发货后 N 天）。 */
  ORDER_AUTO_CONFIRM: "order.auto_confirm",
  /** 结算单生成（按 T+N 汇总 vendor 子单）。 */
  SETTLEMENT_GENERATE: "settlement.generate",
  /** 优惠券过期（批量置失效）。 */
  COUPON_EXPIRE: "coupon.expire",
  /** 物流轨迹同步（写 `order_status_logs`）。 */
  EXPRESS_TRACK_SYNC: "express.track_sync",
} as const;

/** 任务类型（`task_queue.type` 列的取值范围）。 */
export type TaskType = (typeof TASK_TYPE)[keyof typeof TASK_TYPE];

/**
 * 最大尝试次数；达到即置 `failed`（死信，可重放）。
 *
 * ⚠️ **单一来源**：`apps/api/src/jobs/task-queue.ts` 不再定义自己的同值常量，
 * 而是 `export { TASK_MAX_ATTEMPTS }` 从本文件再导出（P2#1）。
 * 默认实现与消费方因此**必然**用同一上限——漂移在编译期就不可能发生。
 */
export const TASK_MAX_ATTEMPTS = 5;

/* -------------------------------------------------------------------------- */
/* 接口                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 入队选项（**可选**第三参数）。
 *
 * `delaySeconds` 是**传输层延迟**：任务最早可被消费的时刻 = 入队时刻 + `delaySeconds`。
 * 两条实现都必须遵守同一语义：
 * - {@link D1TaskQueue}：写 `run_at = now + delaySeconds`（Cron 谓词是 `run_at <= now`）；
 * - {@link QueuesTaskQueue}：透传 Cloudflare Queues 的 `delaySeconds`（上限 43200 秒 = 12 小时）。
 *
 * ⚠️ **不传即保持原行为**（`run_at = now`）——这是缝的纪律：加参数不能改变默认语义。
 * ⚠️ 传输层延迟**不是正确性保证**：时钟漂移 / 手工重放 / 直接 `INSERT` 都能绕过它，
 * 故消费端 handler **必须**自己做二次校验（见 `apps/api/src/jobs/task-queue.ts` 的
 * {@link TaskResult} 协议）。
 */
export interface TaskEnqueueOptions {
  /** 延迟秒数（非负）；`undefined` = 立即可运行（默认行为）。 */
  readonly delaySeconds?: number;
}

/**
 * 异步任务队列端口——升级缝的**唯一抽象点**。
 *
 * 业务代码只依赖本接口，**禁止**直接 `import` Cloudflare Queues 的任何运行时对象。
 */
export interface TaskQueue {
  /** 入队一个任务；**成功返回即代表任务已持久化**（见实现里的 await 说明）。 */
  enqueue(
    type: TaskType,
    payload: Record<string, unknown>,
    options?: TaskEnqueueOptions,
  ): Promise<void>;
}

/** 入队消息体（Queues 侧的消息形状；D1 侧落到 `type` + `payload` 两列）。 */
export interface TaskEnvelope {
  readonly type: TaskType;
  readonly payload: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* 默认实现：D1 任务表                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 默认实现：把任务写入 D1 的 `task_queue` 表（`docs/04` §4.3 S1 默认形态）。
 *
 * ### 为什么 `enqueue` **必须** `await` D1 写入
 *
 * Workers 中**未 await 的 D1 写入可能在响应返回后被取消**（isolate 可能在
 * 后台 promise 落定前被回收 / 请求上下文结束），结果是**任务静默丢失**——
 * 调用方拿到了「入队成功」的假象，而表里什么都没有。
 * 这与「删绑定即回滚、不欠技术债」的纪律直接冲突，故本实现**绝不**用
 * `waitUntil` 或「fire-and-forget」把写入甩到后台，而是**在返回前等写入落定**。
 */
export class D1TaskQueue implements TaskQueue {
  /**
   * @param db   `env.DB` 绑定（写路径，永远走主库；读扩展见 `./read-db.js`）。
   * @param nowMs 当前时刻注入点（默认 `Date.now`），仅供测试。
   */
  public constructor(
    private readonly db: D1Database,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /**
   * 写入 `task_queue`，`status = 'pending'`、`attempts = 0`。
   *
   * `run_at = now + delaySeconds`（不传 `delaySeconds` 时为 `now`——**默认行为零变化**）。
   * Cron 的消费谓词是 `run_at <= now`，故 `run_at` 即「最早可运行时刻」。
   *
   * 列名严格取自迁移 `0001_init.sql` 的 `task_queue` 定义，不做任何裁剪。
   */
  public async enqueue(
    type: TaskType,
    payload: Record<string, unknown>,
    options?: TaskEnqueueOptions,
  ): Promise<void> {
    const nowMs = this.nowMs();
    const nowIso = new Date(nowMs).toISOString();
    // 非负化：负延迟等价于「立即」，避免写进过去的 `run_at`（语义更清晰，结果不变）。
    const delaySeconds = Math.max(0, options?.delaySeconds ?? 0);
    const runAtIso = new Date(nowMs + delaySeconds * 1000).toISOString();

    // ⚠️ 这里的 `await` 是**语义要求**，不是风格问题：
    // 去掉 await 后写入会被运行时取消，任务静默丢失（见类注释）。
    await this.db
      .prepare(
        `INSERT INTO task_queue
           (id, type, payload, status, attempts, run_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?)`,
      )
      .bind(newId(), type, JSON.stringify(payload), runAtIso, nowIso, nowIso)
      .run();
  }
}

/* -------------------------------------------------------------------------- */
/* 升级实现：Cloudflare Queues                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 升级实现：`env.TASK_QUEUE.send(...)`（Cloudflare Queues）。
 *
 * 与默认实现的**语义等价点**：同样在返回前等发送确认（`await`），
 * 失败即抛错让调用方感知——不静默吞掉。
 * Queues 自带重试/退避/死信，故消费方逻辑无需为切换做任何改动。
 *
 * `options.delaySeconds` 透传给 Queues 的原生延迟投递（上限 43200 秒 = 12 小时）；
 * **不传则连 options 一起不传**，与 D1 默认实现「不传即立即可运行」严格对齐。
 */
export class QueuesTaskQueue implements TaskQueue {
  /** @param queue `env.TASK_QUEUE` 绑定。 */
  public constructor(private readonly queue: Queue) {}

  /** 发送 `{ type, payload }` 消息体（`contentType: "json"`，便于消费者直接解析）。 */
  public async enqueue(
    type: TaskType,
    payload: Record<string, unknown>,
    options?: TaskEnqueueOptions,
  ): Promise<void> {
    const message: TaskEnvelope = { type, payload };
    if (options?.delaySeconds === undefined) {
      await this.queue.send(message, { contentType: "json" });
      return;
    }
    await this.queue.send(message, {
      contentType: "json",
      delaySeconds: Math.max(0, options.delaySeconds),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 绑定驱动的工厂                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 按**绑定存在性**选择实现（`docs/12` §12.9.4 第 1 条）。
 *
 * 检测写法固定为 `'TASK_QUEUE' in env && env.TASK_QUEUE`，**不是**单纯的真值判断：
 * - `'TASK_QUEUE' in env` 处理「键存在但值为 `undefined`」；
 * - `&& env.TASK_QUEUE` 处理「键本身不存在」（本地 `wrangler dev`、单元测试的
 *   裸对象字面量都不会带这个键）。
 *
 * 两种缺省形态都必须回落到默认实现，否则本地开发与测试会直接崩。
 */
export function getTaskQueue(env: { DB: D1Database; TASK_QUEUE?: Queue }): TaskQueue {
  if ("TASK_QUEUE" in env && env.TASK_QUEUE) return new QueuesTaskQueue(env.TASK_QUEUE);
  return new D1TaskQueue(env.DB);
}
