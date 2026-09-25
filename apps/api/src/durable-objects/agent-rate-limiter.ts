/**
 * Agent 全局精确限流的 Durable Object（`docs/07` §7.8.3）。
 *
 * **为什么必须是 DO**：限流要「全局精确」，即跨所有 Worker 实例、跨所有边缘
 * PoP 生效。Workers 的 `caches` 与内存计数都做不到精确；D1 写入太贵且无原子
 * 递增保证。DO 是单点串行执行，天然提供原子计数。
 *
 * 设计：
 * - 每个 DO 实例承载一个「令牌 × 端点 × 固定窗口」的计数器
 * - DO 名字由 `tokenId` 派生（`idFromName`），同一令牌的请求路由到同一实例
 * - 计数用内存 Map（窗口内），DO 休眠后内存丢失 = 窗口自然重置，语义正确
 * - 响应 `{ count, limit, allowed }`，由调用方（中间件）组装 HTTP 头
 */

import {
  decideRateLimit,
  RATE_LIMIT_WINDOW_SECONDS,
  secondsUntilWindowReset,
  windowKey,
} from "@dshop/services";
import type { RateLimitDecision } from "@dshop/services";

/** DO 内部状态：窗口键 → 计数。 */
interface CounterState {
  [key: string]: number;
}

export interface RateLimitCheckRequest {
  readonly tokenId: string;
  readonly pathTemplate: string;
  /** 生效限额（调用方已取端点与令牌的较小值）。 */
  readonly limit: number;
  /** 注入当前时间便于测试；缺省用 `Date.now()`。 */
  readonly nowMs?: number;
}

/**
 * Durable Object：固定窗口计数。
 *
 * 只实现 `/check` 一个端点，通过 `fetch` 调用。
 */
export class AgentRateLimiter {
  private counts: CounterState = {};
  private currentWindow = 0;

  constructor(private readonly state: DurableObjectState) {
    // 阻塞并发请求直到持久化计数载入，避免窗口内计数丢失
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<CounterState>("counts");
      if (stored) this.counts = stored;
      const win = await this.state.storage.get<number>("window");
      if (typeof win === "number") this.currentWindow = win;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/check") {
      return new Response("Not Found", { status: 404 });
    }

    let body: RateLimitCheckRequest;
    try {
      body = (await request.json()) as RateLimitCheckRequest;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const nowMs = body.nowMs ?? Date.now();
    const windowStart =
      Math.floor(nowMs / 1000 / RATE_LIMIT_WINDOW_SECONDS) * RATE_LIMIT_WINDOW_SECONDS;

    // 跨窗口：重置全部计数（固定窗口语义）
    if (windowStart !== this.currentWindow) {
      this.counts = {};
      this.currentWindow = windowStart;
    }

    const key = windowKey(body.tokenId, body.pathTemplate, nowMs);
    const next = (this.counts[key] ?? 0) + 1;
    this.counts[key] = next;

    const decision: RateLimitDecision = decideRateLimit({
      count: next,
      limit: body.limit,
      retryAfterSeconds: secondsUntilWindowReset(nowMs),
    });

    // 异步落盘，不阻塞响应（窗口内计数以内存为准）
    this.state.storage.put("counts", this.counts);
    this.state.storage.put("window", this.currentWindow);

    return Response.json(decision);
  }
}
