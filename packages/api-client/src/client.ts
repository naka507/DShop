/**
 * HTTP 传输层（四组共用）。
 *
 * ## 鉴权双模（`docs/06:22`）
 *
 * | 组 | 凭据载体 |
 * | --- | --- |
 * | shop / merchant / admin | HttpOnly Cookie（浏览器自动携带）或 `Authorization: Bearer`（小程序 / APP） |
 * | **agent** | **`X-Service-Token`**（`docs/07` §7.8.1，**非** Bearer） |
 *
 * Agent 令牌**不允许**放 query string（`docs/07:329`），故本层只写请求头。
 *
 * ## 凭据不落 URL
 *
 * `docs/07:134` 要求 Agent 的 `phone` 查询参数不进访问日志；
 * 本层不做任何「把凭据塞进 URL」的便利封装，从源头避免该类泄漏。
 */

import { SERVICE_TOKEN_HEADER } from "@dshop/shared";

import { decodeEnvelope } from "./envelope.js";
import type { Unpacked } from "./envelope.js";
import type { z } from "zod";

/** 请求选项。 */
export interface RequestOptions {
  /** 查询参数；`undefined` 值会被跳过。 */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** 请求体（自动 `JSON.stringify` 并设 `Content-Type`）。 */
  readonly body?: unknown;
  /** 额外请求头。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 条件请求：传上次响应的 `data.contentHash`（`docs/07:150`）。 */
  readonly ifNoneMatch?: string;
  /** 中止信号。 */
  readonly signal?: AbortSignal;
}

/** 客户端配置。 */
export interface ClientConfig {
  /** Base URL，如 `https://api.dshop.example.com`（**不含** `/api/v1`）。 */
  readonly baseUrl: string;
  /**
   * Agent 服务令牌明文（`dshop_svc_<24>_<6>`）。
   *
   * 仅 Agent 组使用；缺失时 Agent 调用会得到 `401` + `40101`。
   * 允许传函数以便**运行时轮换**（`docs/07:333` 双令牌并行）。
   */
  readonly serviceToken?: string | (() => string | undefined);
  /** Bearer 令牌（shop / merchant / admin 的小程序 / APP 模式）。 */
  readonly bearerToken?: string | (() => string | undefined);
  /** 契约版本；默认由 `X-Contract-Version` 头携带 `1`（`docs/07` §7.9）。 */
  readonly contractVersion?: string;
  /** 注入 `fetch`（测试 / SSR 自定义传输）。 */
  readonly fetch?: typeof fetch;
}

/** 路由组。 */
export type ApiGroup = "shop" | "merchant" | "admin" | "agent";

/** 组 → 路径前缀（`docs/06:11-15`）。 */
export const GROUP_PREFIX: Readonly<Record<ApiGroup, string>> = {
  shop: "/api/v1/shop",
  merchant: "/api/v1/merchant",
  admin: "/api/v1/admin",
  agent: "/api/v1/agent",
};

/** 拼接查询串。 */
export function buildQueryString(
  query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text.length > 0 ? `?${text}` : "";
}

/** 解析令牌取值（支持静态值与函数两种形态）。 */
function resolveToken(source: string | (() => string | undefined) | undefined): string | undefined {
  if (source === undefined) return undefined;
  const value = typeof source === "function" ? source() : source;
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 按组构造鉴权头。
 *
 * ⚠️ **Agent 组走 `X-Service-Token`**，不是 `Authorization: Bearer`
 * （`docs/07:329`：服务令牌不是 JWT、不含 `aud`）。
 */
export function authHeadersFor(group: ApiGroup, config: ClientConfig): Record<string, string> {
  if (group === "agent") {
    const token = resolveToken(config.serviceToken);
    return token === undefined ? {} : { [SERVICE_TOKEN_HEADER]: token };
  }
  const bearer = resolveToken(config.bearerToken);
  return bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` };
}

/**
 * 类型化 API 客户端。
 *
 * 泛型 `TGroup` 固定路由组，使 `path` 与鉴权头在**编译期**绑定——
 * 不可能出现「用 Bearer 调 Agent 端点」这种错配。
 */
export class TypedApiClient<TGroup extends ApiGroup> {
  readonly group: TGroup;
  private readonly config: ClientConfig;

  constructor(group: TGroup, config: ClientConfig) {
    this.group = group;
    this.config = config;
  }

  /** 组路径前缀。 */
  get prefix(): string {
    return GROUP_PREFIX[this.group];
  }

  /** 相对路径 → 完整 URL（含查询串）。 */
  url(path: string, query?: RequestOptions["query"]): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${this.prefix}${suffix}${buildQueryString(query)}`;
  }

  /**
   * 发起请求并解包统一响应体。
   *
   * `dataSchema` 是**契约即类型**的落点：`data` 不通过校验即判失败，
   * 而不是把脏数据交给调用方（见 `envelope.ts` 的 `decodeEnvelope`）。
   */
  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    dataSchema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<Unpacked<T>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...authHeadersFor(this.group, this.config),
      ...options.headers,
    };
    const contractVersion = this.config.contractVersion ?? "1";
    if (this.group === "agent") headers["X-Contract-Version"] = contractVersion;
    if (options.ifNoneMatch !== undefined) headers["If-None-Match"] = options.ifNoneMatch;

    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(options.body);
    }
    if (options.signal !== undefined) init.signal = options.signal;

    const fetchImpl = this.config.fetch ?? globalThis.fetch;
    const res = await fetchImpl(this.url(path, options.query), init);
    const body = res.status === 304 ? "" : await res.text();

    return decodeEnvelope({
      // 用**完整路径**判定错误码归属（`isAgentPath()` 认 `/api/v1/agent` 前缀）
      path: `${this.prefix}${path.startsWith("/") ? path : `/${path}`}`,
      status: res.status,
      headers: res.headers,
      body,
      dataSchema,
    });
  }

  /** `GET`。 */
  get<T>(path: string, dataSchema: z.ZodType<T>, options?: RequestOptions): Promise<Unpacked<T>> {
    return this.request("GET", path, dataSchema, options);
  }

  /** `POST`。 */
  post<T>(path: string, dataSchema: z.ZodType<T>, options?: RequestOptions): Promise<Unpacked<T>> {
    return this.request("POST", path, dataSchema, options);
  }

  /** `PUT`。 */
  put<T>(path: string, dataSchema: z.ZodType<T>, options?: RequestOptions): Promise<Unpacked<T>> {
    return this.request("PUT", path, dataSchema, options);
  }

  /** `DELETE`。 */
  delete<T>(
    path: string,
    dataSchema: z.ZodType<T>,
    options?: RequestOptions,
  ): Promise<Unpacked<T>> {
    return this.request("DELETE", path, dataSchema, options);
  }
}
