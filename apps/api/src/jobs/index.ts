/**
 * Cron 任务入口（`docs/08-核心业务流程.md:43,105-111`、`docs/09` §10.2）。
 *
 * ## 分发模式（`docs/08:111`）
 *
 * > `task_queue 消费 | Cron 每分钟 | 按类型分发，单次最多 N=50 条`
 *
 * 全仓库**只有一个 Cron 触发器**，每分钟触发一次，**内部分发任务类型**：
 * `scheduled()` 只做「算出本次该跑哪些 job」这件事，具体逻辑在各 job 函数里。
 * 这样新增定时任务**不需要改 `wrangler.jsonc`**（免费层限 5 个触发器，
 * `docs/09` §10.1；这里只用 1 个）。
 *
 * ## Cron 触发器配置
 *
 * **由 `wrangler.jsonc` 的 `triggers.crons` 提供**（当前为 `["* * * * *"]`），
 * 本文件只实现 handler，**不修改任何配置文件**。
 *
 * ## 当前承载的 job
 *
 * | job | 依据 |
 * | --- | --- |
 * | `agent_audit_flush` —— `agent_call_logs` 批量落库 | `docs/08:110`、`docs/07` §7.8.4「Cron 每分钟批量落库」 |
 * | `task_queue_consume` —— 消费 `task_queue` | `docs/08:111`（单次最多 50 条，`processing` 超时重回 `pending`） |
 *
 * ## 失败语义
 *
 * Cron 的每个 job **独立 try/catch**：一个 job 失败不影响其余 job，
 * 且**绝不抛给 runtime**（抛错会触发 Cron 重试，可能放大故障）。
 * 失败只写结构化告警日志。
 */

import type { Env } from "../env.js";
import { flushAgentAuditBuffer } from "../middleware/agent-audit.js";
import type { TaskEnvelope } from "@dshop/services";

import { consumeTaskQueue, executeTaskEnvelope } from "./task-queue.js";

/** 单一 Cron 的分发单元。 */
export interface CronJob {
  /** 任务类型名（日志与排查用）。 */
  readonly type: string;
  /** 执行体；抛错由 `runCronJobs` 捕获。 */
  readonly run: (env: Env, nowMs: number) => Promise<void>;
}

/**
 * 本次 Cron 要跑的 job 列表（**顺序即执行顺序**）。
 *
 * 目前全量跑（每分钟各一次）。若后续需要不同频率（如「自动确认收货」每小时、
 * 「结算单生成」每日），在 `runCronJobs` 里按 `nowMs` 取模筛即可——
 * 分发点集中在这里，不需要新增触发器。
 */
export const CRON_JOBS: readonly CronJob[] = [
  {
    type: "agent_audit_flush",
    run: async (env) => {
      // `docs/08:110`：Agent 调用审计批量落库（SLO 与 S10/S11 阈值的唯一数据源）
      const written = await flushAgentAuditBuffer(env.DB);
      if (written > 0) {
        // 结构化日志是 Workers 运行时的唯一出口，此处有意使用 console.log
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            level: "info",
            event: "cron_agent_audit_flush",
            written,
          }),
        );
      }
    },
  },
  {
    type: "task_queue_consume",
    run: async (env, nowMs) => {
      await consumeTaskQueue(env.DB, nowMs);
    },
  },
];

/**
 * 依次执行全部 job；单个失败不影响其余。
 *
 * @returns 每个 job 的结果（测试可直接断言，无需解析日志）
 */
export async function runCronJobs(
  env: Env,
  nowMs: number = Date.now(),
): Promise<readonly { readonly type: string; readonly ok: boolean }[]> {
  const results: { type: string; ok: boolean }[] = [];
  for (const job of CRON_JOBS) {
    try {
      await job.run(env, nowMs);
      results.push({ type: job.type, ok: true });
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "cron_job_failed",
          job: job.type,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      results.push({ type: job.type, ok: false });
    }
  }
  return results;
}

/**
 * Workers `scheduled` handler（`apps/api/src/index.ts` 的 `export default` 引用）。
 *
 * `controller` 目前不使用（无 per-invocation 取消需求），保留形参以对齐
 * Workers 运行时签名 `scheduled(controller, env, ctx)`。
 */
export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const startedAt = Date.now();
  const results = await runCronJobs(env, startedAt);
  const summary = {
    level: "info",
    event: "cron_run",
    durationMs: Date.now() - startedAt,
    jobs: results,
  };
  // 结构化日志是 Workers 运行时的唯一出口，此处有意使用 console.log
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary));
  // `ctx.waitUntil` 用于将来把非关键收尾（如指标上报）延后到响应之后；
  // 当前所有 job 已 `await` 完成，无需额外挂载。
  void ctx;
}

/* -------------------------------------------------------------------------- */
/* 升级缝 S1：Cloudflare Queues 出口（`docs/04` §4.3 / `docs/12` §12.9.3）        */
/* -------------------------------------------------------------------------- */

/**
 * Workers `queue` handler —— **升级缝 S1 的消费者出口**。
 *
 * ## 什么时候会被调用
 *
 * **只有** `wrangler.jsonc` 里存在 Queues 绑定（`TASK_QUEUE`）时，
 * Cloudflare 才会把消息投到这里。默认配置**没有任何 Queues 绑定**，
 * 因此本函数在生产默认形态下**永远不会被调用**——这正是「删绑定即回滚」的
 * 含义：不需要任何运行时开关判断，绑定不在就没有调用方。
 *
 * ## 为什么复用 {@link executeTaskEnvelope}
 *
 * 分发逻辑只有一份（`jobs/task-queue.ts` 的 `createTaskHandlers`）。
 * Cron 轮询（默认实现）与 Queues 出口（升级实现）**共用同一张表**，
 * 否则两条路径的行为会漂移——这是 `docs/12` §12.9.4 第 3 条硬规则的直接要求。
 *
 * ## ack / retry 语义
 *
 * - 已注册类型 + handler 成功 → `ack()`
 * - handler 抛错 → `retry()`（交给 Queues 的退避重试，最终进 DLQ）
 * - **未注册类型** → `ack()` + 告警：若 `retry()` 会无限重投
 *   （本版本不认识的消息，重投多少次都不会被认识）
 * - **未到期**（handler 返回 `deferredUntilMs`）→ `retry({ delaySeconds })`
 *   **不 ack**：把消息按剩余延迟重投（`executeTaskEnvelope` 的 {@link TaskResult}
 *   协议）。⚠️ `retry()` 会消耗一次投递尝试，但 Queues 默认 `max_retries` 足够
 *   覆盖一次延后；且生产者的传输层延迟已把消息排到 `pay_deadline` 之后，
 *   本分支只在时钟漂移 / 手工重放时才被走到。
 */
export async function queue(
  batch: MessageBatch<TaskEnvelope>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const outcome = await executeTaskEnvelope(env.DB, message.body);
      if (!outcome.handled) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "queue_task_unregistered",
            taskType: message.body?.type ?? null,
            messageId: message.id,
          }),
        );
        message.ack();
        continue;
      }

      // 未到期：按剩余延迟重投，**不 ack**（消息不能丢）。
      const deferredUntilMs = outcome.deferredUntilMs;
      if (deferredUntilMs !== undefined && deferredUntilMs > Date.now()) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "queue_task_deferred",
            taskType: message.body?.type ?? null,
            messageId: message.id,
            deferredUntilMs,
          }),
        );
        message.retry({
          delaySeconds: Math.ceil((deferredUntilMs - Date.now()) / 1000),
        });
        continue;
      }

      message.ack();
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "queue_task_failed",
          taskType: message.body?.type ?? null,
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      message.retry();
    }
  }
}
