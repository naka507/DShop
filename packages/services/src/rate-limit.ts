/**
 * Agent 限流判定（`docs/07` §7.8.3 / `docs/09`）。
 *
 * 规格：
 * - **全局精确限流**，跨 Worker 实例生效 → 由 Durable Object 承载计数
 * - 每个端点有独立的 `rate_limit_per_min` 与**突发上限**（burst）
 * - 令牌默认 `rate_limit_per_min` = 600
 * - 超限 → HTTP 429 + 错误码 `42901`，并带 `Retry-After`
 *
 * 本模块只做**纯计算**（窗口键、限额解析、响应头），DO 侧负责原子计数。
 */

import { AGENT_ENDPOINTS } from "@dshop/shared";
import type { AgentEndpointSpec } from "@dshop/shared";

/** 固定窗口长度（秒）。文档未定义；实现侧定案：60 秒滚动固定窗口。 */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** 令牌默认每分钟限额（07 §7.8.1）。 */
export const DEFAULT_RATE_LIMIT_PER_MIN = 600;

/** 默认突发上限。文档未定义单值；实现侧定案：取端点 burst 的兜底值 20。 */
export const DEFAULT_BURST = 20;

/**
 * 端点限流规格。
 *
 * ⚠️ 突发上限与缓存 TTL 取自 `packages/shared/src/contracts/agent.ts` 的
 * `AGENT_ENDPOINTS`（M0 实施简报已固化），此处仅做类型安全的查表。
 */
export interface EndpointRateSpec {
  /** 每分钟请求上限。 */
  readonly limitPerMin: number;
  /** 突发上限（同一秒内允许的最大请求数）。 */
  readonly burst: number;
  /** 响应缓存 TTL（秒）；0 表示不缓存。 */
  readonly cacheTtlSeconds: number;
  /** 该端点要求的 scope。 */
  readonly scope: string;
}

/** 按路径模板查端点规格（`path` 为 `AGENT_ENDPOINTS` 中的模板串）。 */
export function endpointSpec(pathTemplate: string): AgentEndpointSpec | undefined {
  return AGENT_ENDPOINTS.find((e) => e.path === pathTemplate);
}

/**
 * 固定窗口的窗口键：`<tokenId>:<pathTemplate>:<windowStartEpochSecond>`。
 *
 * 用**固定窗口**（而非滑动窗口）是为了让 DO 只需存一个整数计数器，
 * 在 D1/DO 上的写入成本最低。
 */
export function windowKey(
  tokenId: string,
  pathTemplate: string,
  nowMs: number,
  windowSeconds: number = RATE_LIMIT_WINDOW_SECONDS,
): string {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  return `${tokenId}:${pathTemplate}:${windowStart}`;
}

/** 当前固定窗口的剩余秒数（用于 `Retry-After`）。 */
export function secondsUntilWindowReset(
  nowMs: number,
  windowSeconds: number = RATE_LIMIT_WINDOW_SECONDS,
): number {
  const elapsed = Math.floor(nowMs / 1000) % windowSeconds;
  return windowSeconds - elapsed;
}

/**
 * 生效限额：**取端点限额与令牌限额的较小值**。
 *
 * 令牌限额（`service_tokens.rate_limit_per_min`，默认 600）是总闸；
 * 端点限额（如 120/min）是细粒度闸。两者取小，保证任一约束都不被突破。
 */
export function effectiveLimit(
  tokenLimitPerMin: number | null | undefined,
  endpointLimitPerMin: number,
): number {
  const tokenLimit =
    typeof tokenLimitPerMin === "number" && tokenLimitPerMin > 0
      ? tokenLimitPerMin
      : DEFAULT_RATE_LIMIT_PER_MIN;
  return Math.min(tokenLimit, endpointLimitPerMin);
}

/** 限流判定结果。 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** 当前窗口内已用次数（含本次）。 */
  readonly count: number;
  /** 生效限额。 */
  readonly limit: number;
  /** 剩余次数。 */
  readonly remaining: number;
  /** 距窗口重置秒数。 */
  readonly retryAfterSeconds: number;
}

/** 由计数结果构造判定。 */
export function decideRateLimit(input: {
  count: number;
  limit: number;
  retryAfterSeconds: number;
}): RateLimitDecision {
  const { count, limit, retryAfterSeconds } = input;
  const allowed = count <= limit;
  return {
    allowed,
    count,
    limit,
    remaining: Math.max(limit - count, 0),
    retryAfterSeconds,
  };
}

/**
 * 限流响应头（成功与失败都要带，便于调用方自适应）。
 *
 * `X-RateLimit-*` 三个头 + 超限时的 `Retry-After`。
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(decision.retryAfterSeconds),
  };
  if (!decision.allowed) {
    headers["Retry-After"] = String(decision.retryAfterSeconds);
  }
  return headers;
}
