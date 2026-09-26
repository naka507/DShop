/**
 * Agent 限流计数存储——**S8 升级缝**的适配器层（`docs/04` §12.4）。
 *
 * ## 为什么需要这一层
 *
 * eshop 的升级缝纪律：**付费/高级组件一律不直接 import**，全部藏在自研接口后面，
 * 由**绑定存在性**驱动实现选择。本文件就是这个「自研接口」：
 *
 * | 绑定状态 | 实现 | 语义 |
 * | --- | --- | --- |
 * | `env.AGENT_RATE_LIMITER` **缺省** | {@link InMemoryRateLimitStore} | 应用层自研固定窗口计数，per-colo 近似配额（`600 × N` 上限）。零配置、免费层可用。 |
 * | `env.AGENT_RATE_LIMITER` **存在** | {@link DurableObjectRateLimitStore} | 跨实例全局精确计数。 |
 *
 * **切换方式**：在 `apps/api/wrangler.jsonc` 增删 `durable_objects` 绑定 + `migrations`。
 * 业务代码零改动；**删绑定即回滚**到默认实现。
 *
 * ## 与旧实现的差异（修正审计发现）
 *
 * 旧实现把 DO 当**必需绑定**，且 DO 故障时 **fail-open（直接放行 = 完全不限流）**。
 * 本实现改为：DO 故障时**回退到默认实现**（降级但仍限流），只有默认实现也异常才放行。
 * 这消除了「降级即不限流」的语义偷换，保住 PiEcho 依赖的限流可预测性（P4）。
 *
 * ## 可观测性（对抗性复核后补齐）
 *
 * 降级**必须留痕**：升级实现不可用时发出结构化告警 `rate_limiter_unavailable`，
 * 并在返回结果里标记 `degraded: true`，由中间件透出 `X-RateLimit-Store` 实际来源
 * 与 `X-RateLimit-Degraded`。**否则「静默降级」会让配额悄悄放大而无线索。**
 */

import {
  decideRateLimit,
  RATE_LIMIT_WINDOW_SECONDS,
  secondsUntilWindowReset,
  windowKey,
} from "@dshop/services";
import type { RateLimitDecision } from "@dshop/services";

/** 限流检查入参。 */
export interface RateLimitCheckInput {
  /** 令牌 ID（缺省时用 `"anonymous"`）。 */
  readonly tokenId: string;
  /** 端点路径模板（`AGENT_ENDPOINTS` 中的模板串）。 */
  readonly pathTemplate: string;
  /** 生效限额 = `min(令牌限额, 端点限额)`。 */
  readonly limit: number;
  /** 当前时间戳（毫秒），便于测试注入。 */
  readonly nowMs: number;
}

/**
 * 限流检查结果：决策 + **实际来源**。
 *
 * `store` / `degraded` 用于可观测性——只有知道「这次决策是谁做的」，
 * 才能判断升级缝当前是否真的生效、是否正在降级。
 */
export interface RateLimitCheckResult {
  /** 限流决策（放行与否、计数、剩余、Retry-After）。 */
  readonly decision: RateLimitDecision;
  /** **实际**作出本次决策的实现名（`memory` / `durable-object`）。 */
  readonly store: string;
  /** 是否处于降级状态（升级实现不可用，已回退到默认实现）。 */
  readonly degraded: boolean;
}

/**
 * 限流计数存储接口——升级缝的**唯一抽象点**。
 *
 * 实现必须是「检查并自增」的原子语义（DO 天然串行；内存实现靠同步临界区）。
 */
export interface RateLimitStore {
  /** 实现名（用于日志；实际来源见 {@link RateLimitCheckResult.store}）。 */
  readonly name: string;
  /** 检查并计数。 */
  check(input: RateLimitCheckInput): Promise<RateLimitCheckResult>;
}

/** 内存窗口计数条目：`key -> { count, expiresAtMs }`。 */
interface WindowEntry {
  count: number;
  expiresAtMs: number;
}

/**
 * **默认实现**：应用层自研固定窗口计数（`docs/04` §12.4 S8「默认实现」）。
 *
 * - 计数存在 Worker isolate 的内存里，**不跨实例**，因此是 per-colo 近似配额。
 * - 每个 colo 各自最多放行 `limit` 次/窗口 → 全局上限约 `limit × N`（N = 活跃 colo 数）。
 *   这与文档所述降级语义一致，且**始终生效**（不会退化为不限流）。
 * - 零配置、零付费依赖，免费层可用。
 *
 * ⚠️ 内存实现会随 isolate 回收而清零（最坏情况提前放行一批），这是可接受的降级代价；
 * 需要全局精确计数时按 S8 升级缝加 `AGENT_RATE_LIMITER` 绑定。
 *
 * **原子性**：`check()` 内 `get` → `count + 1` → `set` 之间**没有任何 `await`**，
 * 临界区是同步的，单线程事件循环下不会交错，因此不会丢计数。
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  public readonly name = "memory";

  /** 窗口计数器。键含窗口起点，因此天然滚动过期。 */
  private readonly windows = new Map<string, WindowEntry>();

  /** 上次清理时间，避免每次请求都全表扫描。 */
  private lastSweepMs = 0;

  /** 清理间隔（毫秒）：每 60 秒最多清理一轮。 */
  private static readonly SWEEP_INTERVAL_MS = 60_000;

  /**
   * 单轮清理上限（条）。
   *
   * 免费层 CPU 预算为 **10ms/请求**（`docs/09` §10.1）。若无上限，
   * 高基数（大量令牌 × 端点）时这一轮全表遍历可能吃掉整个 CPU 预算而 500。
   * 因此**分片清理**：每轮最多删 {@link SWEEP_MAX_DELETIONS} 条，
   * 剩余过期键留给下一轮（它们已不可能再被读取，只是延迟回收）。
   */
  private static readonly SWEEP_MAX_DELETIONS = 200;

  public async check(input: RateLimitCheckInput): Promise<RateLimitCheckResult> {
    const { tokenId, pathTemplate, limit, nowMs } = input;
    this.sweep(nowMs);

    const key = windowKey(tokenId, pathTemplate, nowMs);
    const existing = this.windows.get(key);
    const count = (existing?.count ?? 0) + 1;
    this.windows.set(key, {
      count,
      expiresAtMs: nowMs + RATE_LIMIT_WINDOW_SECONDS * 1000,
    });

    return {
      decision: decideRateLimit({
        count,
        limit,
        retryAfterSeconds: secondsUntilWindowReset(nowMs),
      }),
      store: this.name,
      degraded: false,
    };
  }

  /**
   * 惰性清理过期窗口，防止内存无界增长。
   *
   * **时钟回退防护**：若 `nowMs` 回退（测试注入或时钟异常），差值转负会让
   * 「距上次清理」永远达不到阈值 → 清理长期不执行 → 键无界增长。
   * 因此把 `lastSweepMs` 夹到 `min(nowMs, lastSweepMs)`，回退时立刻触发一轮清理。
   */
  private sweep(nowMs: number): void {
    this.lastSweepMs = Math.min(this.lastSweepMs, nowMs);
    if (nowMs - this.lastSweepMs < InMemoryRateLimitStore.SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = nowMs;

    let deletions = 0;
    for (const [key, entry] of this.windows) {
      if (deletions >= InMemoryRateLimitStore.SWEEP_MAX_DELETIONS) break;
      if (entry.expiresAtMs <= nowMs) {
        this.windows.delete(key);
        deletions += 1;
      }
    }
  }
}

/** DO `check` 接口的响应体（`apps/api/src/durable-objects/agent-rate-limiter.ts`）。 */
interface DoCheckResponse {
  readonly allowed: boolean;
  readonly count: number;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/**
 * 校验 DO 响应形状。
 *
 * **为什么必须校验**：若 DO 返回 200 但字段缺失，`decision.allowed` 会是 `undefined`
 * → 所有请求被判超限，且 `Retry-After` 会序列化成字符串 `"undefined"`。
 * 校验失败即抛错，由调用方走回退分支（降级但仍限流）。
 */
function isDoCheckResponse(value: unknown): value is DoCheckResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["allowed"] === "boolean" &&
    typeof v["count"] === "number" &&
    typeof v["limit"] === "number" &&
    typeof v["remaining"] === "number" &&
    typeof v["retryAfterSeconds"] === "number"
  );
}

/**
 * **升级实现**：Durable Object 全局精确计数（S8 升级缝）。
 *
 * DO 名字由 `tokenId` 派生 → 同一令牌的请求落同一实例，单点串行 = 原子。
 * 该实现**不主动捕获异常**：调用方（{@link createRateLimitStore}）负责回退，
 * 以便区分「DO 挂了」与「真的超限」两种情形。
 */
export class DurableObjectRateLimitStore implements RateLimitStore {
  public readonly name = "durable-object";

  public constructor(private readonly namespace: DurableObjectNamespace) {}

  public async check(input: RateLimitCheckInput): Promise<RateLimitCheckResult> {
    const id = this.namespace.idFromName(input.tokenId);
    const stub = this.namespace.get(id);
    const res = await stub.fetch("https://rate-limiter/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokenId: input.tokenId,
        pathTemplate: input.pathTemplate,
        limit: input.limit,
        // 透传 nowMs：使 DO 侧窗口边界与调用方时钟同源，且可被单测注入。
        nowMs: input.nowMs,
      }),
    });
    if (!res.ok) throw new Error(`rate limiter responded ${res.status}`);

    const body: unknown = await res.json();
    if (!isDoCheckResponse(body)) {
      throw new Error("rate limiter returned malformed payload");
    }
    return { decision: body, store: this.name, degraded: false };
  }
}

/** 进程级默认存储实例（无 DO 绑定时复用，保住内存计数连续性）。 */
let sharedMemoryStore: InMemoryRateLimitStore | undefined;

/**
 * 按绑定存在性选择限流存储——**升级缝的开关实现**。
 *
 * - 无 `AGENT_RATE_LIMITER` → 返回默认实现（应用层自研）。
 * - 有 `AGENT_RATE_LIMITER` → 返回升级实现，并挂上默认实现作为**回退**。
 *
 * 返回的 store 保证 `check()` 永不抛错：升级实现异常时自动降级到默认实现，
 * 从而「降级但仍限流」；降级会**告警**并置 `degraded: true`（不再静默）。
 *
 * @param namespace `env.AGENT_RATE_LIMITER`，缺省表示走默认实现
 */
export function createRateLimitStore(
  namespace: DurableObjectNamespace | undefined,
): RateLimitStore {
  sharedMemoryStore ??= new InMemoryRateLimitStore();
  const fallback = sharedMemoryStore;
  if (!namespace) return fallback;

  const primary = new DurableObjectRateLimitStore(namespace);
  return {
    name: primary.name,
    async check(input: RateLimitCheckInput): Promise<RateLimitCheckResult> {
      try {
        return await primary.check(input);
      } catch (err) {
        // 升级实现不可用 → 回退到默认实现（**降级但仍限流**），而非 fail-open 放行。
        //
        // 降级**必须留痕**：`docs/M0-字段契约.md` §13.2 第 9b 条与 `docs/11` R16
        // 都要求「回退 + 告警 rate_limiter_unavailable」。静默降级会让配额悄悄放大
        // （per-colo 近似，全局上限约 limit × N）而运维无线索。
        //
        // 结构化日志是 Workers 运行时的唯一出口，此处有意使用 console.warn。
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "rate_limiter_unavailable",
            store: primary.name,
            fallback: fallback.name,
            tokenId: input.tokenId,
            pathTemplate: input.pathTemplate,
            error: err instanceof Error ? err.message : String(err),
          }),
        );

        const result = await fallback.check(input);
        // 标记为降级，使中间件能透出真实来源（`X-RateLimit-Store: memory` +
        // `X-RateLimit-Degraded: 1`），而不是继续谎报 `durable-object`。
        return { ...result, degraded: true };
      }
    },
  };
}

/**
 * 供**测试**重置进程级默认实例。
 *
 * @internal 仅供 `tests/` 使用；生产代码不得调用——它会清空全部限流计数（配额绕过）。
 */
export function resetSharedRateLimitStore(): void {
  sharedMemoryStore = undefined;
}
