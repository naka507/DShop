/**
 * 统一 API 调用层（transport）。
 *
 * ## 铁律一：只走相对路径，绝不使用公网绝对 URL
 *
 * `docs/09-认证权限与部署.md` §10.2 与 `docs/04` §4.1：
 * 生产环境由 storefront Worker 用 **Service Binding** 把 `/api/*` 同源转发到 `dshop-api`。
 * 若前端用同 zone 的绝对 URL（如 `https://api.dshop.example.com/...`）发 fetch，
 * 子请求的 Host 头会被绕回发起方自己，**实测表现为静默 404**。
 * 因此 `buildUrl()` 对绝对 URL 直接抛错，把这条约束固化成代码。
 *
 * dev / preview 下由 `vite.config.ts` 的代理转到 `http://127.0.0.1:8787`。
 *
 * ## 铁律二：统一响应体
 *
 * `docs/06-API路由命名空间.md` §6：五组路由共用 `{ code, message, data }`，
 * `code === 0` 为成功；非 0 为业务错误码（shop 组是字符串码）。
 * 分页固定 `{ page, pageSize, total, list }`（与 Agent 组的游标分页不混用）。
 */

import { ShopHttpError, classifyShopHttpStatus, isSuccessCode } from "./errors.ts";

/** shop 组命名空间前缀（`docs/06` §6）。 */
export const SHOP_API_PREFIX = "/api/v1/shop";

/** 统一响应体（`docs/06` §6）。 */
export interface ApiEnvelope<T> {
  readonly code: number | string;
  readonly message: string;
  readonly data: T;
}

/** shop / admin / merchant 三组统一的分页结构（`docs/06` §6）。 */
export interface PageResult<T> {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly list: readonly T[];
}

/** 请求参数。 */
export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** 查询串；`undefined` / `null` 的键会被丢弃。 */
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  /** JSON 请求体。 */
  readonly body?: unknown;
  /**
   * 受控写幂等键。`docs/06` §6：`POST /api/v1/shop/orders` 必须带 `Idempotency-Key`，
   * 否则重复提交会生成重复订单。
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/** 可替换的 fetch 实现（测试注入用）。 */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetcher: Fetcher = (input, init) => fetch(input, init);

/**
 * 拼接请求 URL。
 *
 * @throws 当 `path` 是绝对 URL 时抛错——见文件头的「铁律一」。
 */
export function buildUrl(path: string, query?: RequestOptions["query"]): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new Error(
      `同源转发铁律：API 调用禁止使用绝对 URL（收到 ${path}），见 docs/09-认证权限与部署.md §10.2`,
    );
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (query === undefined) return normalized;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === "" ? normalized : `${normalized}?${qs}`;
}

/** 判断响应体是否是统一响应体。 */
function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "code" in record && "data" in record;
}

/** 读取响应体为 JSON；非 JSON 返回 `null`（不抛错，交由上层统一报错）。 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * 发起一次 shop 组请求并解包 `data`。
 *
 * @param path 相对路径，如 `/products`（会拼上 `SHOP_API_PREFIX`）或完整相对路径 `/api/v1/shop/products`。
 * @throws {ShopHttpError} 任何非成功响应。
 */
export async function request<T>(
  path: string,
  options: RequestOptions = {},
  fetcher: Fetcher = defaultFetcher,
): Promise<T> {
  // 绝对 URL 必须在拼前缀**之前**拦下：否则 `https://...` 会被当成相对路径
  // 拼成 `/api/v1/shophttps://...`，绕过 buildUrl 的检查（同源转发铁律）。
  const url = buildUrl(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith("/api/")
      ? path
      : `${SHOP_API_PREFIX}${path}`,
    options.query,
  );

  const headers = new Headers({ Accept: "application/json" });
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    // HttpOnly Cookie 双模鉴权（docs/09 §9.1）：同源下浏览器自动携带。
    credentials: "include",
  };
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }

  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (cause) {
    // 网络层失败（断网 / 被 CORS 拦下）：status 记为 0。
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ShopHttpError({ code: "", message: `网络请求失败：${message}`, status: 0 });
  }

  const requestId = response.headers.get("X-Request-Id");
  const payload = await readJson(response);

  if (!isEnvelope(payload)) {
    throw new ShopHttpError({
      code: "",
      message: response.ok
        ? "响应体不符合统一响应体 {code,message,data}"
        : `HTTP ${String(response.status)}`,
      status: response.status,
      requestId,
    });
  }

  if (!isSuccessCode(payload.code)) {
    const code = String(payload.code);
    throw new ShopHttpError({
      code,
      message:
        typeof payload.message === "string" && payload.message !== ""
          ? payload.message
          : "请求失败",
      // 后端可能返回 HTTP 200 + 业务错误码；此时按错误码语义兜底状态。
      status:
        response.status >= 400
          ? response.status
          : classifyShopHttpStatus(response.status) === "unknown"
            ? 200
            : response.status,
      requestId,
    });
  }

  return payload.data as T;
}

/** 固定了 fetcher 的请求器（供 `@dshop/api-client` 集成缝与测试复用）。 */
export type Requester = <T>(path: string, options?: RequestOptions) => Promise<T>;

/** 便于测试与多端复用的工厂：固定一个 fetcher。 */
export function createRequester(fetcher: Fetcher): Requester {
  return <T>(path: string, options?: RequestOptions) => request<T>(path, options, fetcher);
}
