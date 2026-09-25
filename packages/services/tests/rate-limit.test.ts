import { describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION_HEADER,
  CURRENT_CONTRACT_VERSION,
  resolveContractVersion,
  SUPPORTED_CONTRACT_VERSIONS,
} from "../src/contract-version.js";
import {
  decideRateLimit,
  DEFAULT_RATE_LIMIT_PER_MIN,
  effectiveLimit,
  endpointSpec,
  RATE_LIMIT_WINDOW_SECONDS,
  rateLimitHeaders,
  secondsUntilWindowReset,
  windowKey,
} from "../src/rate-limit.js";

describe("契约版本（docs/07 §7.1）", () => {
  it("头名与当前版本", () => {
    expect(CONTRACT_VERSION_HEADER).toBe("X-Contract-Version");
    expect(CURRENT_CONTRACT_VERSION).toBe("1");
    expect(SUPPORTED_CONTRACT_VERSIONS).toContain("1");
  });

  it("缺失视为 1 并标记 missing", () => {
    expect(resolveContractVersion(null)).toEqual({
      ok: true,
      version: "1",
      missing: true,
      raw: null,
    });
    expect(resolveContractVersion(undefined).missing).toBe(true);
    expect(resolveContractVersion("").missing).toBe(true);
    expect(resolveContractVersion("   ").missing).toBe(true);
  });

  it("显式 1 通过且不标记 missing", () => {
    expect(resolveContractVersion("1")).toEqual({
      ok: true,
      version: "1",
      missing: false,
      raw: "1",
    });
  });

  it("不支持的版本 → ok=false（调用方回 400 + 40010）", () => {
    expect(resolveContractVersion("2").ok).toBe(false);
    expect(resolveContractVersion("0").ok).toBe(false);
    expect(resolveContractVersion("v1").ok).toBe(false);
  });
});

describe("限流（docs/07 §7.8.3）", () => {
  it("固定窗口 60 秒", () => {
    expect(RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(DEFAULT_RATE_LIMIT_PER_MIN).toBe(600);
  });

  it("窗口键在窗口内稳定，跨窗口变化", () => {
    const t1 = Date.UTC(2026, 8, 20, 6, 30, 0);
    const t2 = Date.UTC(2026, 8, 20, 6, 30, 59);
    const t3 = Date.UTC(2026, 8, 20, 6, 31, 0);
    const k1 = windowKey("TOK", "/orders/{orderNo}", t1);
    expect(windowKey("TOK", "/orders/{orderNo}", t2)).toBe(k1);
    expect(windowKey("TOK", "/orders/{orderNo}", t3)).not.toBe(k1);
    expect(k1).toBe(`TOK:/orders/{orderNo}:${Math.floor(t1 / 1000)}`);
  });

  it("窗口键区分令牌与路径", () => {
    const t = Date.UTC(2026, 8, 20, 6, 30, 0);
    expect(windowKey("A", "/orders", t)).not.toBe(windowKey("B", "/orders", t));
    expect(windowKey("A", "/orders", t)).not.toBe(windowKey("A", "/products", t));
  });

  it("Retry-After 在窗口边界正确", () => {
    const atBoundary = Date.UTC(2026, 8, 20, 6, 30, 0);
    expect(secondsUntilWindowReset(atBoundary)).toBe(60);
    expect(secondsUntilWindowReset(atBoundary + 30_000)).toBe(30);
    expect(secondsUntilWindowReset(atBoundary + 59_000)).toBe(1);
  });

  it("生效限额取端点与令牌的较小值", () => {
    expect(effectiveLimit(600, 120)).toBe(120);
    expect(effectiveLimit(60, 120)).toBe(60);
    expect(effectiveLimit(null, 120)).toBe(120);
    expect(effectiveLimit(undefined, 300)).toBe(300);
    expect(effectiveLimit(0, 120)).toBe(120);
    expect(effectiveLimit(-5, 120)).toBe(120);
  });

  it("端点规格查表（六端点，Hono 风格路径模板）", () => {
    const orderDetail = endpointSpec("/orders/:orderNo");
    expect(orderDetail).toBeDefined();
    expect(orderDetail?.rateLimitPerMin).toBe(120);
    expect(orderDetail?.burst).toBe(20);

    const orderList = endpointSpec("/orders");
    expect(orderList?.rateLimitPerMin).toBe(120);

    const policies = endpointSpec("/policies/:category");
    expect(policies?.rateLimitPerMin).toBe(60);
    expect(policies?.cacheTtlSeconds).toBe(300);

    const specs = endpointSpec("/products/:spuId/specs");
    expect(specs?.rateLimitPerMin).toBe(300);
    expect(specs?.cacheTtlSeconds).toBe(60);

    const stock = endpointSpec("/products/:spuId/stock");
    expect(stock?.cacheTtlSeconds).toBe(30);

    const aftersales = endpointSpec("/aftersales/:aftersaleNo");
    expect(aftersales?.scope).toBe("agent:aftersale:read");

    expect(endpointSpec("/nope")).toBeUndefined();
  });

  it("decideRateLimit 边界：恰好等于限额仍放行", () => {
    const at = decideRateLimit({ count: 120, limit: 120, retryAfterSeconds: 30 });
    expect(at.allowed).toBe(true);
    expect(at.remaining).toBe(0);

    const over = decideRateLimit({ count: 121, limit: 120, retryAfterSeconds: 30 });
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("响应头：成功不含 Retry-After，超限才含", () => {
    const ok = rateLimitHeaders(
      decideRateLimit({ count: 10, limit: 120, retryAfterSeconds: 40 }),
    );
    expect(ok["X-RateLimit-Limit"]).toBe("120");
    expect(ok["X-RateLimit-Remaining"]).toBe("110");
    expect(ok["X-RateLimit-Reset"]).toBe("40");
    expect(ok["Retry-After"]).toBeUndefined();

    const limited = rateLimitHeaders(
      decideRateLimit({ count: 121, limit: 120, retryAfterSeconds: 40 }),
    );
    expect(limited["Retry-After"]).toBe("40");
    expect(limited["X-RateLimit-Remaining"]).toBe("0");
  });
});
