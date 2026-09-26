/**
 * S8 升级缝的**真实入口**覆盖（补 `rate-limit-seam.test.ts` 的单元盲区）。
 *
 * `rate-limit-seam.test.ts` 直接调 `createRateLimitStore()`，验证的是 store 本身；
 * 本文件经**真实生产入口**（`../src/index.js` 的 `app.request`）打已登记端点，
 * 覆盖三处此前无回归网的地方：
 *
 * 1. **默认路径（无绑定）**：`c.env.AGENT_RATE_LIMITER` 为 `undefined` 时中间件不报错，
 *    且响应头 `X-RateLimit-Store: memory`（证明真的走了默认实现）。
 * 2. **429 路径**：超限时返回 `429` + `code 42901` + `Retry-After` + 完整 `X-RateLimit-*`。
 * 3. **来源头如实**：有绑定时 `X-RateLimit-Store` 指向升级实现。
 *
 * 依据：`docs/07` §7.8.3（限流响应）、`docs/04` §4.3 S8（升级缝）。
 */

import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/index.js";
import { resetSharedRateLimitStore } from "../src/lib/rate-limit-store.js";
import {
  agentRequest,
  createAgentTestEnv,
  createAgentTestEnvWithoutRateLimiter,
  setTokenRateLimit,
} from "./helpers/agent-env.js";

/** 一个已登记的 Agent 端点（`/orders/{orderNo}`），命中 rateLimit 中间件。 */
const ORDER_PATH = "/api/v1/agent/orders/DS20260920143000123";

describe("S8 升级缝 · 真实入口：绑定缺省 → 默认实现", () => {
  beforeEach(() => {
    resetSharedRateLimitStore();
    setTokenRateLimit(600);
  });

  it("无 DO 绑定时请求成功，且 X-RateLimit-Store 为 memory（证明走了默认实现）", async () => {
    const env = createAgentTestEnvWithoutRateLimiter();
    const res = await agentRequest(app, ORDER_PATH, env);

    // 未报错（若中间件把可选绑定当必需，这里会是 500）
    expect(res.status).not.toBe(500);
    expect(res.headers.get("X-RateLimit-Store")).toBe("memory");
    // 未降级：本来就没有升级实现
    expect(res.headers.get("X-RateLimit-Degraded")).toBeNull();
  });

  it("无绑定时**确实在限流**：连续请求到第 limit+1 次返回 429", async () => {
    const env = createAgentTestEnvWithoutRateLimiter();
    setTokenRateLimit(2); // 令牌维度限额 2/min（端点维度 120，取较小值 2）

    const first = await agentRequest(app, ORDER_PATH, env);
    const second = await agentRequest(app, ORDER_PATH, env);
    const third = await agentRequest(app, ORDER_PATH, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // 第 3 次超限：这是「默认实现真的生效」的决定性证据
    expect(third.status).toBe(429);
  });
});

describe("S8 升级缝 · 真实入口：429 响应契约", () => {
  beforeEach(() => {
    resetSharedRateLimitStore();
    setTokenRateLimit(1);
  });

  it("超限返回 429 + 整数码 42901 + Retry-After + 完整 X-RateLimit-*", async () => {
    const env = createAgentTestEnvWithoutRateLimiter();
    await agentRequest(app, ORDER_PATH, env); // 用掉唯一额度
    const res = await agentRequest(app, ORDER_PATH, env);

    expect(res.status).toBe(429);
    // Agent 组用整数错误码（`docs/README.md:34` 契约分层）
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(42901);
    expect(typeof body.message).toBe("string");

    // 超限响应也必须带完整限流头，便于调用方自适应
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(res.headers.get("X-RateLimit-Limit")).not.toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Store")).toBe("memory");
  });
});

describe("S8 升级缝 · 真实入口：来源头如实反映实现", () => {
  beforeEach(() => {
    resetSharedRateLimitStore();
    setTokenRateLimit(600);
  });

  it("有绑定时 X-RateLimit-Store 为 durable-object（升级缝已生效）", async () => {
    // 测试 helper 注入的假 DO 恒放行；此处只验证来源头与实际实现一致
    const env = createAgentTestEnv();
    const res = await agentRequest(app, ORDER_PATH, env);

    expect(res.status).not.toBe(500);
    expect(res.headers.get("X-RateLimit-Store")).toBe("durable-object");
    expect(res.headers.get("X-RateLimit-Degraded")).toBeNull();
  });
});
