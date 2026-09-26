/**
 * 后台 API 客户端适配层（**与 `@dshop/api-client` 的唯一耦合点**）。
 *
 * 设计依据：
 * - `docs/03` §3.5.2：两入口共用 `packages/api-client` 与 `packages/shared` 的权限点定义
 * - `docs/04` §4.1：`/api/*` 由各自 Worker 用 **Service Binding** 同源转发到 `dshop-api`，
 *   因此前端**一律用相对路径**，绝不用公网绝对 URL（否则 HttpOnly Cookie 跨站、
 *   `SameSite=Lax` 失效、Service Binding 转发被绕过）
 * - `docs/06` §6：统一响应体 `{ code, message, data }`；后台组 `code` 为**字符串**错误码
 *
 * ## 为什么这里做「适配 + 降级」
 *
 * `packages/api-client` 由另一位同事并行创建，其导出形状在本文件写作时尚未冻结。
 * 本文件因此：
 * 1. 只在这一处 import `@dshop/api-client`（其余代码只依赖本文件的导出）；
 * 2. 运行时探测该包是否提供了可用的请求函数，**探测不到就降级到本地 `fetch`**；
 * 3. 无论走哪条路径，请求 URL 都是相对路径 `/api/v1/*`，并带 `credentials: "include"`。
 *
 * 待 `packages/api-client` 形状冻结后，可删掉降级分支，直接绑定其导出。
 */

import * as apiClientModule from "@dshop/api-client";

import { API_PREFIX } from "./endpoints.js";
import { ADMIN_ERROR_CODES, classifyErrorCode, describeErrorCode, isOkCode } from "./errors.js";

/* -------------------------------------------------------------------------- */
/* 统一响应体（docs/06 §6）                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 统一响应体。
 *
 * `code` 同时可能是**字符串**（shop / admin / merchant 组）或**整数**（Agent 组）；
 * 后台界面只会收到字符串码，但类型上放宽以避免把契约写死在这里。
 */
export interface ApiEnvelope<T> {
  readonly code: string | number;
  readonly message: string;
  readonly data: T;
}

/** 分页载荷的运行时形状校验（宽松：只保证 `list` 是数组）。 */
interface PageLike {
  readonly list: readonly unknown[];
  readonly page?: number;
  readonly pageSize?: number;
  readonly total?: number;
}

/** API 失败（`code !== 0/OK`，或 HTTP 非 2xx）。 */
export class ApiError extends Error {
  /** 业务错误码（字符串或整数）。 */
  public readonly code: string | number;
  /** HTTP 状态码（网络层失败时为 `0`）。 */
  public readonly httpStatus: number;
  /** 错误码所属路由组（`docs/06` §6 的错误码分流）。 */
  public readonly group: ReturnType<typeof classifyErrorCode>;

  public constructor(code: string | number, message: string, httpStatus = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.group = classifyErrorCode(code);
  }

  /** 是否为「未登录 / 登录过期」，调用方可据此跳登录页。 */
  public get isUnauthorized(): boolean {
    return (
      this.code === ADMIN_ERROR_CODES.UNAUTHORIZED ||
      this.code === ADMIN_ERROR_CODES.TOKEN_MISSING_OR_INVALID ||
      this.httpStatus === 401
    );
  }

  /** 是否为「权限不足」（后端 `requirePerm()` 拦截）。 */
  public get isForbidden(): boolean {
    return this.code === ADMIN_ERROR_CODES.FORBIDDEN || this.httpStatus === 403;
  }
}

/* -------------------------------------------------------------------------- */
/* 传输层：优先 @dshop/api-client，缺失时降级到同源 fetch                        */
/* -------------------------------------------------------------------------- */

/** 本地期望的客户端形状（`@dshop/api-client` 若提供同形函数即被采用）。 */
interface RequestCapable {
  request<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>>;
}

/** 运行时探测 `@dshop/api-client` 是否提供了可用的请求函数。 */
function resolvePackageClient(): RequestCapable | null {
  const candidate: unknown = (apiClientModule as { createApiClient?: unknown }).createApiClient;
  if (typeof candidate === "function") {
    try {
      // 约定：`createApiClient(options?)` 返回带 `request(path, init)` 的客户端。
      const created: unknown = (candidate as (options?: unknown) => unknown)({
        basePath: API_PREFIX,
        credentials: "include",
      });
      if (isRequestCapable(created)) return created;
    } catch {
      // 形状不符即降级；不把并行开发期的接口差异暴露给页面。
    }
  }
  if (isRequestCapable(apiClientModule)) return apiClientModule;
  return null;
}

function isRequestCapable(value: unknown): value is RequestCapable {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { request?: unknown }).request === "function";
}

/**
 * 降级传输：同源 `fetch` + 相对路径。
 *
 * `credentials: "include"` 是必需的——后台鉴权用 **HttpOnly Cookie**
 * （`docs/09` §9.1），不带凭据则每个请求都会 401。
 */
async function fetchEnvelope<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiError(
      ADMIN_ERROR_CODES.INTERNAL_ERROR,
      `响应不是合法 JSON（HTTP ${String(response.status)}）`,
      response.status,
    );
  }

  if (!isEnvelope(parsed)) {
    throw new ApiError(
      ADMIN_ERROR_CODES.INTERNAL_ERROR,
      `响应体不符合统一信封 { code, message, data }（HTTP ${String(response.status)}）`,
      response.status,
    );
  }
  return parsed as ApiEnvelope<T>;
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { code?: unknown; message?: unknown; data?: unknown };
  const codeOk = typeof record.code === "string" || typeof record.code === "number";
  return codeOk && typeof record.message === "string" && "data" in record;
}

/** 实际使用的传输实现（模块加载时定一次）。 */
const transport: RequestCapable = resolvePackageClient() ?? { request: fetchEnvelope };

/* -------------------------------------------------------------------------- */
/* 对外请求 API                                                                */
/* -------------------------------------------------------------------------- */

/** 请求选项。 */
export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  /** 查询参数（`undefined` / `null` 的键会被跳过）。 */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined | null>>;
  readonly signal?: AbortSignal;
}

/** 拼接查询串（跳过空值，避免 `?status=undefined`）。 */
function withQuery(path: string, query: RequestOptions["query"]): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length === 0 ? path : `${path}?${qs}`;
}

/**
 * 发起一次后台 API 调用并**解包**统一信封。
 *
 * 成功（`code === 0` / `"OK"`）返回 `data`；失败抛 `ApiError`。
 * 错误码文案经 `describeErrorCode()` 归一——后台组是字符串码（`docs/06` §6）。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const envelope = await transport.request<T>(withQuery(path, options.query), init);

  if (!isOkCode(envelope.code)) {
    throw new ApiError(envelope.code, describeErrorCode(envelope.code, envelope.message), 0);
  }
  return envelope.data;
}

/** GET。 */
export function get<T>(
  path: string,
  query?: RequestOptions["query"],
  signal?: AbortSignal,
): Promise<T> {
  return request<T>(path, {
    method: "GET",
    ...(query === undefined ? {} : { query }),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** POST。 */
export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, body === undefined ? { method: "POST" } : { method: "POST", body });
}

/** PUT。 */
export function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, body === undefined ? { method: "PUT" } : { method: "PUT", body });
}

/**
 * 取分页载荷并做最小形状兜底。
 *
 * 后端分页统一 `{ page, pageSize, total, list }`（`docs/06` §6）；此处对
 * 缺字段的响应做降级，避免并行开发期列表页直接崩。
 */
export async function getPage<T>(
  path: string,
  query?: RequestOptions["query"],
  signal?: AbortSignal,
): Promise<{ page: number; pageSize: number; total: number; list: T[] }> {
  const data = await get<PageLike>(path, query, signal);
  const list = Array.isArray(data.list) ? (data.list as T[]) : [];
  return {
    page: typeof data.page === "number" ? data.page : 1,
    pageSize: typeof data.pageSize === "number" ? data.pageSize : list.length,
    total: typeof data.total === "number" ? data.total : list.length,
    list,
  };
}

/** 供测试与调试：当前是否使用了 `@dshop/api-client`（而非降级 fetch）。 */
export function isUsingPackageClient(): boolean {
  return transport.request !== fetchEnvelope;
}
