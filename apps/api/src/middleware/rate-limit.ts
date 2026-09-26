/**
 * 限流中间件（`docs/07` §7.8.3 / `docs/04` §12.4 S8 升级缝）。
 *
 * ## 中间件链位置（`docs/06` §6.x）
 *
 * 必须排在 **`auth` 之后**：生效限额 = `min(令牌限额, 端点限额)`，
 * 不先解析令牌就拿不到 `service_tokens.rate_limit_per_min`，也无法按令牌分桶。
 * （文档 `docs/06:53` 把 `rateLimit` 写在 `auth` 之前，属笔误，见 `docs/M0-字段契约.md` §7 定案。）
 *
 * ## 升级缝（S8）
 *
 * 计数存储由 **绑定存在性**决定，本中间件不感知具体实现：
 * - 无 `AGENT_RATE_LIMITER` → 默认实现：应用层自研固定窗口计数（per-colo 近似配额）
 * - 有 `AGENT_RATE_LIMITER` → 升级实现：Durable Object 全局精确计数
 *
 * 详见 `apps/api/src/lib/rate-limit-store.ts`。**删绑定即回滚**。
 *
 * ## 降级语义（修正旧实现的语义偷换）
 *
 * 旧实现：DO 故障 → **fail-open 直接放行**（等于完全不限流）。
 * 新实现：升级实现故障 → **回退到默认实现**（降级但仍限流）；默认实现本身不抛错。
 * 因此本中间件的 `catch` 分支只在「默认实现也异常」时触发，属真正的兜底放行。
 *
 * 超限 → `429` + `42901` + `Retry-After`；无论放行与否都带 `X-RateLimit-*`。
 */

import {
  effectiveLimit,
  endpointSpec,
  rateLimitHeaders,
  secondsUntilWindowReset,
} from "@dshop/services";
import type { MiddlewareHandler } from "hono";

import type { Env } from "../env.js";
import type { AppEnv } from "../lib/context.js";
import { rateLimited } from "../lib/errors.js";
import { createRateLimitStore } from "../lib/rate-limit-store.js";
import type { RateLimitCheckResult } from "../lib/rate-limit-store.js";

export const rateLimit = (): MiddlewareHandler<AppEnv & { Bindings: Env }> => async (c, next) => {
  const token = c.get("serviceToken");
  const template = c.get("endpointTemplate") ?? c.req.path;
  const spec = endpointSpec(template);

  // 未登记模板：不施加端点级限流（仍受令牌总闸约束）
  const endpointLimit = spec?.rateLimitPerMin ?? Number.MAX_SAFE_INTEGER;
  const limit = effectiveLimit(token?.rateLimitPerMin, endpointLimit);

  // 绑定驱动选择实现：无 DO 绑定 → 默认实现（应用层自研），有绑定 → 升级实现（带默认回退）。
  const store = createRateLimitStore(c.env.AGENT_RATE_LIMITER);

  let result: RateLimitCheckResult;
  try {
    result = await store.check({
      tokenId: token?.id ?? "anonymous",
      pathTemplate: template,
      limit,
      nowMs: Date.now(),
    });
  } catch (err) {
    // 兜底：默认实现本身异常时放行（限流是保护措施，不应导致整体不可用）。
    // 注意：升级实现（DO）故障**不会**走到这里——它在 createRateLimitStore 内部
    // 已回退到默认实现并告警 `rate_limiter_unavailable`（降级但仍限流）。
    // 此处仅在**默认实现自身也异常**时触发，属真正的最后兜底。
    // 结构化日志是 Workers 运行时的唯一出口，此处有意使用 console.warn。
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "rate_limiter_unavailable",
        store: store.name,
        fallback: "fail-open",
        requestId: c.get("requestId") ?? null,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    result = {
      decision: {
        allowed: true,
        count: 0,
        limit,
        remaining: limit,
        retryAfterSeconds: secondsUntilWindowReset(Date.now()),
      },
      store: store.name,
      degraded: true,
    };
  }

  const { decision } = result;

  /** 写入限流头：来源头用**实际**作出决策的实现，降级时额外标记。 */
  const applyHeaders = (headers: Headers): void => {
    for (const [k, v] of Object.entries(rateLimitHeaders(decision))) {
      headers.set(k, v);
    }
    headers.set("X-RateLimit-Store", result.store);
    if (result.degraded) headers.set("X-RateLimit-Degraded", "1");
  };

  if (!decision.allowed) {
    const res = rateLimited(decision.retryAfterSeconds, "请求过于频繁，请稍后重试");
    // 超限响应也要带完整限流头，便于调用方自适应。
    applyHeaders(res.headers);
    return res;
  }

  await next();

  // 把限流头合并进最终响应
  applyHeaders(c.res.headers);
};
