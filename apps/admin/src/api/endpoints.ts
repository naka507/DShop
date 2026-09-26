/**
 * 后台端点定义（`docs/06-API路由命名空间.md` §6）。
 *
 * **全部为相对路径**，前缀固定 `/api/v1`：
 * - 本地开发由 Vite proxy 转发到 `http://127.0.0.1:8787`
 * - 生产由本 Worker 用 Service Binding 同源转发到 `dshop-api`（`docs/04` §4.1）
 *
 * ★ **绝不使用公网绝对 URL**（否则 HttpOnly Cookie 跨站、`SameSite=Lax` 失效，
 * 且 `docs/04` §4.1 的 Service Binding 转发路径被绕过）。
 */

import type { AdminEntry } from "../entry.js";

/** API 前缀（相对路径，不含域名）。 */
export const API_PREFIX = "/api/v1";

/**
 * ★ PiEcho 运营入口（M0 必须交付，`docs/09` §9.2）：
 * - `AGENT_TOKENS`     —— 签发 / 吊销服务令牌，权限点 `agent:token:manage`
 * - `AFTERSALE_POLICIES` —— 政策发布，权限点 `aftersale:policy:manage`
 */
export const ADMIN_ENDPOINTS = {
  /** 登录（账号 + 密码 + 可选 TOTP）。 */
  LOGIN: "/admin/login",
  REFRESH: "/admin/refresh",
  LOGOUT: "/admin/logout",
  /** 当前身份与权限点。 */
  ME: "/admin/me",

  /* ★ PiEcho 运营入口之一：Agent 服务令牌（docs/06 §6 / 07 §7.8.1） */
  AGENT_TOKENS: "/admin/agent-tokens",
  /** 吊销：`POST /api/v1/admin/agent-tokens/:id/revoke`。 */
  AGENT_TOKEN_REVOKE: (id: string): string =>
    `/admin/agent-tokens/${encodeURIComponent(id)}/revoke`,

  /* ★ PiEcho 运营入口之二：售后政策（docs/06 §6 / 07 §7.7） */
  AFTERSALE_POLICIES: "/admin/aftersale-policies",

  /* 订单 / 售后 / 商品 / 商户（只读为主） */
  ORDERS: "/admin/orders",
  ORDER_DETAIL: (orderNo: string): string => `/admin/orders/${encodeURIComponent(orderNo)}`,
  AFTERSALES: "/admin/aftersales",
  AFTERSALE_DETAIL: (aftersaleNo: string): string =>
    `/admin/aftersales/${encodeURIComponent(aftersaleNo)}`,
  PRODUCTS: "/admin/products",
  CATEGORIES: "/admin/categories",
  MERCHANTS: "/admin/merchants",
  STORES: "/admin/stores",
} as const;

/**
 * 商户入口端点。
 *
 * 与平台入口**接口不同、Token `aud` 不同、权限集不同**（`docs/03` §3.5.2 硬性规则）。
 * 商户侧无 Agent 令牌 / 售后政策入口——那两个权限点属平台运营角色（`docs/09` §9.2）。
 */
export const MERCHANT_ENDPOINTS = {
  LOGIN: "/merchant/login",
  REFRESH: "/merchant/refresh",
  LOGOUT: "/merchant/logout",
  ME: "/merchant/me",
  ORDERS: "/merchant/orders",
  ORDER_DETAIL: (orderNo: string): string => `/merchant/orders/${encodeURIComponent(orderNo)}`,
  AFTERSALES: "/merchant/aftersales",
  AFTERSALE_DETAIL: (aftersaleNo: string): string =>
    `/merchant/aftersales/${encodeURIComponent(aftersaleNo)}`,
  PRODUCTS: "/merchant/products",
  CATEGORIES: "/merchant/categories",
  MERCHANTS: "/merchant/merchants",
  STORES: "/merchant/stores",
} as const;

/** 端点集合（两入口结构同构，仅前缀不同）。 */
export interface EndpointSet {
  readonly LOGIN: string;
  readonly REFRESH: string;
  readonly LOGOUT: string;
  readonly ME: string;
  readonly ORDERS: string;
  readonly ORDER_DETAIL: (orderNo: string) => string;
  readonly AFTERSALES: string;
  readonly AFTERSALE_DETAIL: (aftersaleNo: string) => string;
  readonly PRODUCTS: string;
  readonly CATEGORIES: string;
  readonly MERCHANTS: string;
  readonly STORES: string;
}

/**
 * 平台入口端点集合。
 *
 * `AGENT_TOKENS` / `AFTERSALE_POLICIES` **仅平台入口存在**（PiEcho 运营入口），
 * 商户入口传入 `undefined`，页面据此隐藏入口（与后端 `aud` 校验双重拦截）。
 */
export interface PlatformEndpointSet extends EndpointSet {
  readonly AGENT_TOKENS: string;
  readonly AGENT_TOKEN_REVOKE: (id: string) => string;
  readonly AFTERSALE_POLICIES: string;
}

/** 商户入口端点集合（无 PiEcho 专属端点）。 */
export type MerchantEndpointSet = EndpointSet;

/** 按入口取端点集合。 */
export function endpointsFor(entry: AdminEntry): PlatformEndpointSet | MerchantEndpointSet {
  return entry === "platform" ? ADMIN_ENDPOINTS : MERCHANT_ENDPOINTS;
}

/** 类型守卫：该端点集合是否含 PiEcho 专属入口（仅平台后台有）。 */
export function hasAgentEndpoints(
  set: PlatformEndpointSet | MerchantEndpointSet,
): set is PlatformEndpointSet {
  return "AGENT_TOKENS" in set;
}
