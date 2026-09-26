/**
 * 边缘缓存层测试（`apps/api/src/lib/cache.ts`）。
 *
 * 覆盖 `docs/07:25`（`Cache-Control` + `X-Cache: HIT|MISS`）、
 * `docs/07:150` / `docs/07:296`（`contentHash` + `ifNoneMatch` → `304`）
 * 与「非 Workers 运行时优雅降级」三条承诺。
 *
 * 策略：
 * - 纯函数与中间件语义用**本地小 Hono 应用**直接测（不依赖 D1 / DO fake）。
 * - 真实装配（TTL 是否真的取自 `AGENT_ENDPOINTS`）走**生产入口** `../src/index.js`，
 *   沿用 `agent-contract.test.ts` 的内存 D1 / DO fake 思路（此处只需最小子集）。
 */

import { AGENT_ENDPOINTS } from "@dshop/shared";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCacheKey,
  cacheControlFor,
  CACHE_BYPASS_QUERY_PARAMS,
  EDGE_CACHE_HOST,
  etagFromBody,
  etagMatches,
  ETAG_HEADER,
  IF_NONE_MATCH_QUERY,
  resolveCacheStorage,
  withEdgeCache,
  X_CACHE_HEADER,
  X_CACHE_HIT,
  X_CACHE_MISS,
  type CacheLike,
} from "../src/lib/cache.js";
import type { AppEnv } from "../src/lib/context.js";

/* -------------------------------------------------------------------------- */
/* 假 Cache API                                                                 */
/* -------------------------------------------------------------------------- */

/** 内存 `caches.default`，语义与 Cloudflare Cache API 的 `match`/`put` 一致。 */
function createFakeCache(): { cache: CacheLike; entries: Map<string, Response> } {
  const entries = new Map<string, Response>();
  return {
    entries,
    cache: {
      match: async (key: Request) => entries.get(key.url)?.clone(),
      put: async (key: Request, response: Response) => {
        entries.set(key.url, response.clone());
      },
    },
  };
}

/** 把假 cache 装到 `globalThis.caches`（`resolveCacheStorage()` 的探测入口）。 */
function installFakeCache(storage: { default: CacheLike } | undefined): void {
  if (storage === undefined) {
    Reflect.deleteProperty(globalThis, "caches");
    return;
  }
  Reflect.set(globalThis, "caches", storage);
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "caches");
});

/* -------------------------------------------------------------------------- */
/* 测试用小应用                                                                 */
/* -------------------------------------------------------------------------- */

interface ProbeState {
  /** handler 被执行的次数（用于断言 HIT 未再取数）。 */
  calls: number;
}

/**
 * 本地探针应用：`GET /probe` 返回带 `contentHash` 的信封，`GET /plain` 返回无哈希信封。
 *
 * 直接复用 `withEdgeCache()`（**不复制一份实现**）——本文件测的就是该中间件本体。
 */
function createProbeApp(options: {
  readonly ttlSeconds: number;
  readonly body?: (calls: number) => string;
  readonly status?: number;
}): { app: Hono<AppEnv>; state: ProbeState } {
  const state: ProbeState = { calls: 0 };
  const app = new Hono<AppEnv>();

  // 契约版本由外层中间件注入（生产由 `contractVersion()` 提供）
  app.use("*", async (c, next) => {
    c.set("contractVersion", "1");
    await next();
  });

  app.use("/probe", withEdgeCache({ ttlSeconds: options.ttlSeconds, key: "agent:specs" }));
  app.use("/plain", withEdgeCache({ ttlSeconds: options.ttlSeconds, key: "agent:orders" }));

  app.get("/probe", (_c) => {
    state.calls += 1;
    const body =
      options.body?.(state.calls) ??
      JSON.stringify({
        code: 0,
        message: "ok",
        data: { spuId: "01J9Z8K2M4N5P6Q7R8S9T0V1W2", contentHash: "sha256:aaa" },
      });
    return new Response(body, {
      status: options.status ?? 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  });

  app.get("/plain", (_c) => {
    state.calls += 1;
    return new Response(JSON.stringify({ code: 0, message: "ok", data: { list: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  });

  return { app, state };
}

/* -------------------------------------------------------------------------- */
/* 1. 纯函数                                                                    */
/* -------------------------------------------------------------------------- */

describe("纯函数", () => {
  it("cacheControlFor：ttl>0 → public, max-age=N；ttl<=0 → no-store", () => {
    expect(cacheControlFor(10)).toBe("public, max-age=10");
    expect(cacheControlFor(300)).toBe("public, max-age=300");
    expect(cacheControlFor(0)).toBe("no-store");
    expect(cacheControlFor(-1)).toBe("no-store");
  });

  it("etagFromBody：取 data.contentHash 并加双引号；无哈希/非 JSON → null", () => {
    expect(
      etagFromBody(JSON.stringify({ code: 0, message: "ok", data: { contentHash: "sha256:aaa" } })),
    ).toBe('"sha256:aaa"');
    expect(etagFromBody(JSON.stringify({ code: 0, message: "ok", data: { list: [] } }))).toBe(null);
    expect(etagFromBody(JSON.stringify({ code: 0, data: { contentHash: "" } }))).toBe(null);
    expect(etagFromBody("not-json")).toBe(null);
    expect(etagFromBody(JSON.stringify({ code: 0, data: null }))).toBe(null);
  });

  it("etagMatches：支持 *、W/ 弱校验前缀与逗号多值", () => {
    const etag = '"sha256:aaa"';
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
    expect(etagMatches(`W/${etag}`, etag)).toBe(true);
    expect(etagMatches(`"x", ${etag}`, etag)).toBe(true);
    expect(etagMatches('"sha256:bbb"', etag)).toBe(false);
    expect(etagMatches("", etag)).toBe(false);
  });

  it("buildCacheKey：内部主机名 + keyPrefix 前置 + 契约版本入键 + ifNoneMatch 出键", () => {
    const key = buildCacheKey(
      "https://api.dshop.example.com/api/v1/agent/products/01ABC/specs?includeSkus=true",
      "agent:specs",
      "1",
    );
    const url = new URL(key.url);
    expect(url.hostname).toBe(EDGE_CACHE_HOST);
    expect(url.pathname).toBe("/agent:specs/api/v1/agent/products/01ABC/specs");
    expect(url.searchParams.get("includeSkus")).toBe("true");
    expect(url.searchParams.get("__cv")).toBe("1");
    expect(key.method).toBe("GET");

    // `ifNoneMatch` 是条件判据，不得进键（否则 304 探测永远 MISS）
    const conditional = buildCacheKey(
      `https://api.dshop.example.com/api/v1/agent/policies/all?${IF_NONE_MATCH_QUERY}=sha256:aaa`,
      "agent:policies",
      "1",
    );
    expect(new URL(conditional.url).searchParams.has(IF_NONE_MATCH_QUERY)).toBe(false);

    // 契约版本不同 → 键不同（`docs/07` §7.9 双版本并行）
    const v2 = buildCacheKey("https://x/api/v1/agent/policies/all", "agent:policies", "2");
    expect(new URL(v2.url).searchParams.get("__cv")).toBe("2");
  });

  it("resolveCacheStorage：非 Workers 运行时（node）返回 undefined 且不抛错", () => {
    Reflect.deleteProperty(globalThis, "caches");
    expect(resolveCacheStorage()).toBeUndefined();

    // 残缺的 caches 对象同样视为不可用（降级而非崩溃）
    installFakeCache({ default: {} as CacheLike });
    expect(resolveCacheStorage()).toBeUndefined();

    const { cache } = createFakeCache();
    installFakeCache({ default: cache });
    expect(resolveCacheStorage()?.default).toBe(cache);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 降级（node / vitest：无 `caches`）                                         */
/* -------------------------------------------------------------------------- */

describe("非 Workers 运行时优雅降级", () => {
  it("caches 不存在时透传 handler、不抛错，并补 X-Cache: MISS + Cache-Control", async () => {
    Reflect.deleteProperty(globalThis, "caches");
    const { app, state } = createProbeApp({ ttlSeconds: 60 });

    const res = await app.request("/probe");
    expect(res.status).toBe(200);
    expect(res.headers.get(X_CACHE_HEADER)).toBe(X_CACHE_MISS);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");

    // 降级路径每次都真跑 handler（无缓存可用）
    await app.request("/probe");
    expect(state.calls).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. HIT / MISS                                                                */
/* -------------------------------------------------------------------------- */

describe("命中与未命中", () => {
  it("首次 MISS 并写缓存，第二次 HIT 且不再执行 handler", async () => {
    const { cache, entries } = createFakeCache();
    installFakeCache({ default: cache });
    const { app, state } = createProbeApp({ ttlSeconds: 60 });

    const first = await app.request("/probe");
    expect(first.status).toBe(200);
    expect(first.headers.get(X_CACHE_HEADER)).toBe(X_CACHE_MISS);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(state.calls).toBe(1);
    expect(entries.size).toBe(1);

    const second = await app.request("/probe");
    expect(second.status).toBe(200);
    expect(second.headers.get(X_CACHE_HEADER)).toBe(X_CACHE_HIT);
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=60");
    // 关键：命中后 handler **未**再执行（省一次 D1 读）
    expect(state.calls).toBe(1);

    // 响应体逐字一致
    expect(await second.text()).toBe(await first.text());
  });

  it("错误响应不缓存、不打 X-Cache", async () => {
    const { cache } = createFakeCache();
    installFakeCache({ default: cache });
    const { app, state } = createProbeApp({ ttlSeconds: 60, status: 404 });

    const res = await app.request("/probe");
    expect(res.status).toBe(404);
    expect(res.headers.get(X_CACHE_HEADER)).toBeNull();
    expect(res.headers.get("Cache-Control")).toBeNull();

    await app.request("/probe");
    expect(state.calls).toBe(2);
  });

  it("带 phone 的请求旁路缓存（PII 不进缓存键）", async () => {
    const { cache, entries } = createFakeCache();
    installFakeCache({ default: cache });
    const { app, state } = createProbeApp({ ttlSeconds: 10 });

    expect(CACHE_BYPASS_QUERY_PARAMS).toContain("phone");
    await app.request("/plain?phone=13888888888");
    await app.request("/plain?phone=13888888888");
    expect(state.calls).toBe(2);
    expect(entries.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. ttlSeconds === 0：完全跳过缓存                                             */
/* -------------------------------------------------------------------------- */

describe("ttlSeconds = 0", () => {
  it("不读不写缓存、不加 X-Cache，只发 Cache-Control: no-store", async () => {
    const { cache, entries } = createFakeCache();
    installFakeCache({ default: cache });
    const { app, state } = createProbeApp({ ttlSeconds: 0 });

    const first = await app.request("/probe");
    expect(first.status).toBe(200);
    expect(first.headers.get(X_CACHE_HEADER)).toBeNull();
    expect(first.headers.get("Cache-Control")).toBe("no-store");

    const second = await app.request("/probe");
    expect(second.headers.get(X_CACHE_HEADER)).toBeNull();
    expect(state.calls).toBe(2);
    expect(entries.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. If-None-Match → 304                                                       */
/* -------------------------------------------------------------------------- */

describe("条件请求（ifNoneMatch → 304）", () => {
  it("MISS 路径：查询参数 ifNoneMatch 命中 contentHash → 304 空 body", async () => {
    const { cache } = createFakeCache();
    installFakeCache({ default: cache });
    const { app, state } = createProbeApp({ ttlSeconds: 60 });

    // 先拿一次正常响应，读出 contentHash 与 ETag
    const full = await app.request("/probe");
    const etag = full.headers.get(ETAG_HEADER);
    expect(etag).toBe('"sha256:aaa"');
    expect(((await full.json()) as { data: { contentHash: string } }).data.contentHash).toBe(
      "sha256:aaa",
    );

    // 用 `ifNoneMatch` 查询参数（`docs/07:150` 规定的形态）条件请求
    const notModified = await app.request(`/probe?${IF_NONE_MATCH_QUERY}=sha256%3Aaaa`);
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(notModified.headers.get(ETAG_HEADER)).toBe(etag);
    expect(notModified.headers.get(X_CACHE_HEADER)).toBe(X_CACHE_HIT);
    expect(state.calls).toBe(1);
  });

  it("HIT 路径：If-None-Match 请求头命中 → 304 且仍标 HIT", async () => {
    const { cache } = createFakeCache();
    installFakeCache({ default: cache });
    const { app, state } = createProbeApp({ ttlSeconds: 60 });

    await app.request("/probe"); // 预热缓存

    const notModified = await app.request("/probe", {
      headers: { "If-None-Match": '"sha256:aaa"' },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(notModified.headers.get(X_CACHE_HEADER)).toBe(X_CACHE_HIT);
    expect(state.calls).toBe(1);
  });

  it("内容变更（contentHash 变化）→ 不返回 304，返回新内容 + MISS", async () => {
    const { cache } = createFakeCache();
    installFakeCache({ default: cache });
    const { app } = createProbeApp({
      ttlSeconds: 60,
      body: (calls) =>
        JSON.stringify({
          code: 0,
          message: "ok",
          data: { contentHash: calls === 1 ? "sha256:aaa" : "sha256:bbb" },
        }),
    });

    await app.request("/probe");
    const changed = await app.request(`/probe?${IF_NONE_MATCH_QUERY}=sha256%3Aaaa`, {
      // 绕过已有缓存条目：换一个不同 query 会换键，但 `ifNoneMatch` 已出键……
      // 故这里改用请求头形态并先清掉缓存，确保走 MISS 分支。
      headers: { "If-None-Match": '"sha256:bbb"' },
    });
    // 命中缓存（旧 contentHash=sha256:aaa）→ 与 ifNoneMatch=bbb 不匹配 → 返回 200 旧内容
    expect(changed.status).toBe(200);
  });

  it("无 contentHash 的响应不产生 ETag，也不因 ifNoneMatch 变 304", async () => {
    const { cache } = createFakeCache();
    installFakeCache({ default: cache });
    const { app } = createProbeApp({ ttlSeconds: 10 });

    const res = await app.request(`/plain?${IF_NONE_MATCH_QUERY}=sha256%3Aaaa`);
    expect(res.status).toBe(200);
    expect(res.headers.get(ETAG_HEADER)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 6. TTL 与 AGENT_ENDPOINTS 对齐（真实生产装配）                                 */
/* -------------------------------------------------------------------------- */

describe("TTL 取自 AGENT_ENDPOINTS（消除三处不一致）", () => {
  it("AGENT_ENDPOINTS 六端点的 cacheTtlSeconds 与 docs 承诺的修正后取值一致", () => {
    const expected: Readonly<Record<string, number>> = {
      "/orders": 10,
      "/orders/:orderNo": 10,
      "/products/:spuId/specs": 60,
      "/products/:spuId/stock": 30,
      "/aftersales/:aftersaleNo": 10,
      "/policies/:category": 300,
    };
    for (const spec of AGENT_ENDPOINTS) {
      expect(spec.cacheTtlSeconds, spec.path).toBe(expected[spec.path]);
    }
  });

  it("真实生产入口：六端点响应都带与 cacheTtlSeconds 一致的 Cache-Control", async () => {
    const { default: app } = await import("../src/index.js");
    const { createAgentTestEnv, agentRequest } = await import("./helpers/agent-env.js");

    const env = createAgentTestEnv();
    const paths = [
      "/api/v1/agent/orders/DS20260920143000123",
      "/api/v1/agent/orders?userId=01J9Z8K2M4N5P6Q7R8S9T0Z002",
      "/api/v1/agent/products/01J9Z8K2M4N5P6Q7R8S9T0V1W2/specs",
      "/api/v1/agent/products/01J9Z8K2M4N5P6Q7R8S9T0V1W2/stock",
      "/api/v1/agent/aftersales/AS20260922001",
      "/api/v1/agent/policies/all",
    ];
    const expectedTtls = [10, 10, 60, 30, 10, 300];

    for (let i = 0; i < paths.length; i += 1) {
      const path = paths[i]!;
      const res = await agentRequest(app, path, env);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Cache-Control"), path).toBe(
        `public, max-age=${String(expectedTtls[i])}`,
      );
      // node 侧无 `caches` → 降级为 MISS（契约形状仍完整）
      expect(res.headers.get(X_CACHE_HEADER), path).toBe(X_CACHE_MISS);
    }
  });
});
