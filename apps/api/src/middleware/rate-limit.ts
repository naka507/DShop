/**
 * 限流中间件（`docs/07` §7.8.3）。
 *
 * 调用 DO（`AgentRateLimiter`）做**全局精确计数**：
 * - DO 名字由 `tokenId` 派生，同一令牌的请求落同一实例（单点串行 = 原子）
 * - 生效限额 = `min(端点限额, 令牌限额)`
 * - 超限 → `429` + `42901` + `Retry-After`
 * - 无论放行与否，响应都带 `X-RateLimit-*` 头
 *
 * ⚠️ DO 不可用时**降级放行**（fail-open）并告警：限流是保护措施，
 * 不应因限流设施故障而整体拒绝服务。
 */

import {
  effectiveLimit,
  endpointSpec,
  rateLimitHeaders,
  secondsUntilWindowReset,
} from "@dshop/services";
import type { RateLimitDecision } from "@dshop/services";
import type { MiddlewareHandler } from "hono";

import type { Env } from "../env.js";
import type { AppEnv } from "../lib/context.js";
import { rateLimited } from "../lib/errors.js";

export const rateLimit = (): MiddlewareHandler<AppEnv & { Bindings: Env }> => async (
  c,
  next,
) => {
  const token = c.get("serviceToken");
  const template = c.get("endpointTemplate") ?? c.req.path;
  const spec = endpointSpec(template);

  // 未登记模板：不施加端点级限流（仍受令牌总闸约束）
  const endpointLimit = spec?.rateLimitPerMin ?? Number.MAX_SAFE_INTEGER;
  const limit = effectiveLimit(token?.rateLimitPerMin, endpointLimit);

  let decision: RateLimitDecision;
  try {
    const id = c.env.AGENT_RATE_LIMITER.idFromName(token?.id ?? "anonymous");
    const stub = c.env.AGENT_RATE_LIMITER.get(id);
    const res = await stub.fetch("https://rate-limiter/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokenId: token?.id ?? "anonymous",
        pathTemplate: template,
        limit,
      }),
    });
    if (!res.ok) throw new Error(`rate limiter responded ${res.status}`);
    decision = (await res.json()) as RateLimitDecision;
  } catch (err) {
    // fail-open：限流设施故障不应导致整体不可用
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "rate_limiter_unavailable",
        requestId: c.get("requestId") ?? null,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    decision = {
      allowed: true,
      count: 0,
      limit,
      remaining: limit,
      retryAfterSeconds: secondsUntilWindowReset(Date.now()),
    };
  }

  if (!decision.allowed) {
    return rateLimited(decision.retryAfterSeconds, "请求过于频繁，请稍后重试");
  }

  await next();

  // 把限流头合并进最终响应
  for (const [k, v] of Object.entries(rateLimitHeaders(decision))) {
    c.res.headers.set(k, v);
  }
};
