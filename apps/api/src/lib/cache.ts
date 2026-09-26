/**
 * Agent 组边缘缓存中间件（Cloudflare Cache API，`docs/07` §7.1 / §7.3 / §7.4 / §7.7）。
 *
 * ## 补的缺口
 *
 * `docs/07:25` 承诺「响应带 `Cache-Control` 与 `X-Cache: HIT|MISS`」，
 * `docs/07:150` / `docs/07:296` 承诺 `contentHash` + `ifNoneMatch` 条件请求返回 `304`，
 * `docs/04:52`（升级缝 S7）把「Cache API 边缘缓存」定为一期实现。
 * 但此前代码**只有 `Cache-Control` 响应头**：全仓库 `caches.*` 零命中、
 * 无 `X-Cache`、无 `304`，且 TTL 三处不一致（`docs/M0-字段契约.md` §13.9 第 48 项自认偏差）。
 * 本文件把这三件事一次补齐。
 *
 * ## TTL 唯一来源
 *
 * `ttlSeconds` **由调用方传入**，取值一律来自 `AGENT_ENDPOINTS[].cacheTtlSeconds`
 * （`packages/shared/src/contracts/agent.ts:421-470`）。`docs/07:10` 的既定裁决原则是
 * 「文档与 Schema 不一致时以 Schema 为准」，故：
 *
 * | 端点 | Schema TTL | 修正前实发 `Cache-Control` |
 * | --- | --- | --- |
 * | `/orders` | 10s | `no-store`（不一致） |
 * | `/orders/:orderNo` | 10s | `no-store`（不一致，正文称「不缓存」） |
 * | `/products/:spuId/specs` | 60s | `max-age=60`（一致） |
 * | `/products/:spuId/stock` | 30s | `max-age=30`（一致） |
 * | `/aftersales/:aftersaleNo` | 10s | `no-store`（不一致） |
 * | `/policies/:category` | 300s | `max-age=300`（一致） |
 *
 * ## 降级（**必须**）
 *
 * 测试与本地开发跑在 node 运行时，`caches` 不存在（node 24 实测 `typeof caches === "undefined"`）。
 * 此时**不抛错**，直接透传 handler，只补 `Cache-Control` 与 `X-Cache: MISS`——
 * 让契约形状在 node / Workers 两侧一致（`docs/03` §3.1）。
 *
 * ## 只读
 *
 * 只对 `GET` 生效（Agent 组本就只读，`docs/07` §7.8.3）。
 */

import type { Context, MiddlewareHandler } from "hono";

import type { Env } from "../env.js";
import type { AppEnv } from "./context.js";

/* -------------------------------------------------------------------------- */
/* 常量                                                                         */
/* -------------------------------------------------------------------------- */

/** `X-Cache` 响应头名（`docs/07:25`）。 */
export const X_CACHE_HEADER = "X-Cache";

/** 命中缓存。 */
export const X_CACHE_HIT = "HIT";

/** 未命中（含降级与旁路）。 */
export const X_CACHE_MISS = "MISS";

/** `ETag` 响应头名。 */
export const ETAG_HEADER = "ETag";

/** `If-None-Match` 请求头名。 */
export const IF_NONE_MATCH_HEADER = "If-None-Match";

/**
 * `ifNoneMatch` 查询参数名。
 *
 * `docs/07:150` / `docs/07:296` 规定 PiEcho **用查询参数**（而非请求头）传
 * 上次响应的 `data.contentHash`；本中间件**两者都认**，请求头优先。
 */
export const IF_NONE_MATCH_QUERY = "ifNoneMatch";

/**
 * 缓存键使用的内部主机名。
 *
 * Cache API 的键必须是 URL，而 `docs/07:130` 规定的键是 `agent:orders:{userId}:...`
 * 这种「非 URL」形态；故用固定内部主机名承载，键前缀作为首个路径段。
 * 该主机名**不参与路由**，仅作 Cache API 键的命名空间。
 */
export const EDGE_CACHE_HOST = "edge-cache.dshop.internal";

/**
 * 触发**缓存旁路**的查询参数名。
 *
 * `docs/07:134` 要求 `phone` 不进访问日志；同理它也**不应进缓存键**
 * （缓存键会在 PoP 上留存）。带这些参数的请求一律不读不写缓存，
 * 直接透传 handler（`docs/09:53` 的 PII 口径）。
 */
export const CACHE_BYPASS_QUERY_PARAMS: readonly string[] = ["phone"];

/* -------------------------------------------------------------------------- */
/* 类型                                                                         */
/* -------------------------------------------------------------------------- */

/** Cache API 单例缓存（`caches.default` 的结构子集）。 */
export interface CacheLike {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

/** `caches` 全局对象的结构子集（只用到 `default`）。 */
export interface CacheStorageLike {
  readonly default: CacheLike;
}

/** 中间件选项。 */
export interface EdgeCacheOptions {
  /**
   * 边缘缓存秒数，取自 `AGENT_ENDPOINTS[].cacheTtlSeconds`。
   *
   * `<= 0` → **完全跳过缓存**（不读不写、不加 `X-Cache`），只发 `Cache-Control: no-store`。
   */
  readonly ttlSeconds: number;
  /** 端点级缓存键前缀，取自 `AGENT_ENDPOINTS[].cacheKeyPrefix`（如 `agent:orders`）。 */
  readonly key: string;
}

/* -------------------------------------------------------------------------- */
/* 运行时探测（降级入口）                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 取 `caches.default`；**非 Workers 运行时返回 `undefined`**（不抛错）。
 *
 * 用 `globalThis` 而非裸 `caches` 标识符：node 侧该标识符不存在，
 * 裸引用在严格模式下会抛 `ReferenceError`。
 */
export function resolveCacheStorage(): CacheStorageLike | undefined {
  const candidate = (globalThis as { readonly caches?: unknown }).caches;
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== "object") return undefined;

  const fallback = (candidate as { readonly default?: unknown }).default;
  if (fallback === undefined || fallback === null) return undefined;
  if (typeof fallback !== "object") return undefined;

  const cache = fallback as Partial<CacheLike>;
  if (typeof cache.match !== "function" || typeof cache.put !== "function") return undefined;

  return { default: cache as CacheLike };
}

/* -------------------------------------------------------------------------- */
/* 纯函数（可直接单测）                                                          */
/* -------------------------------------------------------------------------- */

/** `ttlSeconds` → `Cache-Control`（`docs/07:25`）。 */
export function cacheControlFor(ttlSeconds: number): string {
  return ttlSeconds > 0 ? `public, max-age=${ttlSeconds}` : "no-store";
}

/**
 * 从响应体提取 `data.contentHash` 并转成 `ETag`。
 *
 * `docs/07:429` 承诺 `contentHash` 在内容**任何变更**时都会改变，
 * 故它是 `ifNoneMatch` 判据的唯一来源（不用 `updatedAt`）。
 * 非 JSON / 无 `contentHash`（如 `/orders` 列表）→ `null`（该响应无 304 语义）。
 */
export function etagFromBody(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const data = (parsed as { readonly data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;

  const hash = (data as { readonly contentHash?: unknown }).contentHash;
  if (typeof hash !== "string" || hash.trim().length === 0) return null;

  // ETag 语法要求双引号包裹；`contentHash` 形如 `sha256:9f2c1a...`（`docs/07:161`）
  return `"${hash.replace(/"/g, "")}"`;
}

/**
 * `If-None-Match` 取值与当前 `ETag` 是否匹配。
 *
 * **两侧都做规范化**（去 `W/` 前缀、去首尾双引号）后再比对：
 * `docs/07:150` / `docs/07:296` 规定 PiEcho 传的是 `data.contentHash` **原值**
 * （如 `sha256:9f2c1a...`，不带引号），而 HTTP `ETag` 语法要求带双引号——
 * 若严格按 RFC 比对，查询参数形态将永远不匹配，304 形同虚设。
 *
 * 同时支持 `*` 与逗号分隔多值（RFC 9110 §13.1.2）。
 */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const target = normalizeEtag(etag);
  for (const raw of ifNoneMatch.split(",")) {
    const token = raw.trim();
    if (token.length === 0) continue;
    if (token === "*") return true;
    if (normalizeEtag(token) === target) return true;
  }
  return false;
}

/** 去 `W/` 前缀与首尾双引号，得到可比较的实体标签。 */
function normalizeEtag(value: string): string {
  const trimmed = value.trim();
  const withoutWeak = trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
  return withoutWeak.replace(/^"|"$/g, "");
}

/**
 * 构造 Cache API 键。
 *
 * 形态：`https://edge-cache.dshop.internal/<keyPrefix><原始 path>?<原始 query>&__cv=<契约版本>`。
 *
 * - 契约版本进键：`docs/07` §7.9 要求破坏性变更 ≥90 天双版本并行，
 *   两版响应体不同，必须分开缓存。
 * - `ifNoneMatch` **出键**：它是条件请求判据而非资源标识，留在键里会让
 *   每次 304 探测都算一次 MISS（键各不相同），条件请求永不生效。
 */
export function buildCacheKey(
  requestUrl: string,
  keyPrefix: string,
  contractVersion: string | undefined,
): Request {
  const url = new URL(requestUrl);
  url.protocol = "https:";
  url.hostname = EDGE_CACHE_HOST;
  url.port = "";
  url.pathname = `/${keyPrefix}${url.pathname}`;
  url.searchParams.delete(IF_NONE_MATCH_QUERY);
  if (contractVersion !== undefined && contractVersion.length > 0) {
    url.searchParams.set("__cv", contractVersion);
  }
  return new Request(url.toString(), { method: "GET" });
}

/* -------------------------------------------------------------------------- */
/* 响应头落盘（单一出口）                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 补 `Cache-Control`，并按需补 `X-Cache`。
 *
 * **只在 `200` / `304` 上落头**：错误响应（400/401/403/404/405/429）既不缓存
 * 也不标 `X-Cache`——标 `MISS` 会让调用方误以为「缓存里有但没命中」，标 `HIT` 更糟；
 * 同时保持「错误响应无 `Cache-Control`」这一既有对外行为不变。
 */
function applyCacheHeaders(res: Response, ttlSeconds: number, xCache: string | null): Response {
  if (res.status !== 200 && res.status !== 304) return res;
  res.headers.set("Cache-Control", cacheControlFor(ttlSeconds));
  if (xCache !== null) res.headers.set(X_CACHE_HEADER, xCache);
  return res;
}

/** 缓存故障告警（结构化日志，不含 PII）。 */
function warnCacheFailure(event: string, requestId: string | undefined, err: unknown): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event,
      requestId: requestId ?? null,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

/**
 * 把缓存写放到 `waitUntil`（不阻塞响应）；无 ExecutionContext 时**同步等待**。
 *
 * Hono 的 `c.executionCtx` getter 在缺失时**抛错**（不是返回 `undefined`），
 * 因此这里必须 try/catch；node / vitest 下退化为 await，保证写缓存已落定，
 * 测试与本地行为可预测。
 */
async function scheduleCacheWrite<E extends AppEnv>(
  c: Context<E>,
  task: Promise<void>,
): Promise<void> {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    await task;
  }
}

/* -------------------------------------------------------------------------- */
/* 中间件                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 边缘缓存中间件。
 *
 * 语义（`docs/07:25`）：
 * - 命中 → 直接返回缓存响应 + `X-Cache: HIT`
 * - 未命中 → 执行 handler、写缓存 + `X-Cache: MISS`
 * - `ttlSeconds <= 0` → **完全跳过缓存**，不加 `X-Cache`，只发 `Cache-Control: no-store`
 * - `If-None-Match`（或查询参数 `ifNoneMatch`）命中 `contentHash` → `304 Not Modified`（空 body）
 * - `caches` 不存在（node / vitest）→ 透传 handler，不抛错
 *
 * **挂载位置**：必须排在 `serviceTokenAuth` 与 `rateLimit` **之后**
 * （`apps/api/src/routes/agent/index.ts`）——否则未认证请求也能读缓存，
 * 且命中会绕过限流计数（`docs/07` §7.8.4 要求每次调用都计入配额）。
 */
export function withEdgeCache(
  options: EdgeCacheOptions,
): MiddlewareHandler<AppEnv & { Bindings: Env }> {
  return async (c, next) => {
    // 只读保证：Agent 组只挂 GET，这里再兜一层（`docs/07` §7.8.3）
    if (c.req.method !== "GET") {
      await next();
      return;
    }

    const { ttlSeconds, key } = options;

    // ttl <= 0：完全跳过缓存（不读不写、不加 X-Cache）
    if (!(ttlSeconds > 0)) {
      await next();
      applyCacheHeaders(c.res, ttlSeconds, null);
      return;
    }

    const storage = resolveCacheStorage();
    const bypassed = CACHE_BYPASS_QUERY_PARAMS.some((param) => c.req.query(param) !== undefined);

    // 降级 / PII 旁路：透传 handler，只补契约头
    if (storage === undefined || bypassed) {
      await next();
      applyCacheHeaders(c.res, ttlSeconds, X_CACHE_MISS);
      return;
    }

    const cache = storage.default;
    const cacheKey = buildCacheKey(c.req.url, key, c.get("contractVersion"));
    const ifNoneMatch = c.req.header(IF_NONE_MATCH_HEADER) ?? c.req.query(IF_NONE_MATCH_QUERY);

    /* ---------------- 命中 ---------------- */

    let cached: Response | undefined;
    try {
      cached = await cache.match(cacheKey);
    } catch (err) {
      // 缓存读故障不应影响可用性（`docs/11` R2：读路径以缓存为主，但缓存不是真相源）
      warnCacheFailure("edge_cache_match_failed", c.get("requestId"), err);
      cached = undefined;
    }

    if (cached !== undefined) {
      const hit = new Response(cached.body, cached);
      const etag = hit.headers.get(ETAG_HEADER);
      if (etag !== null && ifNoneMatch !== undefined && etagMatches(ifNoneMatch, etag)) {
        return applyCacheHeaders(
          new Response(null, { status: 304, headers: { [ETAG_HEADER]: etag } }),
          ttlSeconds,
          X_CACHE_HIT,
        );
      }
      return applyCacheHeaders(hit, ttlSeconds, X_CACHE_HIT);
    }

    /* ---------------- 未命中 ---------------- */

    await next();
    const res = c.res;

    // 只缓存成功响应；错误响应既不缓存也不标 X-Cache
    if (res.status !== 200) return applyCacheHeaders(res, ttlSeconds, null);

    const etag = etagFromBody(await res.clone().text());
    if (etag !== null) res.headers.set(ETAG_HEADER, etag);

    // 条件请求：内容未变更 → 304（`docs/07:150` / `docs/07:296`）
    if (etag !== null && ifNoneMatch !== undefined && etagMatches(ifNoneMatch, etag)) {
      return applyCacheHeaders(
        new Response(null, { status: 304, headers: { [ETAG_HEADER]: etag } }),
        ttlSeconds,
        X_CACHE_MISS,
      );
    }

    applyCacheHeaders(res, ttlSeconds, X_CACHE_MISS);

    // 写缓存：`clone()` 保证响应体仍可下发给调用方；失败仅告警（缓存是加速，不是真相源）
    const write = cache
      .put(cacheKey, res.clone())
      .catch((err: unknown) => warnCacheFailure("edge_cache_put_failed", c.get("requestId"), err));

    // `c.executionCtx` 在无 ExecutionContext 时**抛异常**（不是返回 undefined），
    // 故不能用 `?.`——必须 try/catch 才能既用 waitUntil 又在 node 侧不炸。
    await scheduleCacheWrite(c, write);
  };
}
