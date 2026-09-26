/**
 * 后台领域 API（把端点 + 类型组合成页面可直接调用的函数）。
 *
 * 全部走 `client.ts` 的相对路径传输；错误以 `ApiError` 抛出，页面统一展示。
 */

import { get, getPage, post, put } from "./client.js";
import { ADMIN_ENDPOINTS, MERCHANT_ENDPOINTS, type PlatformEndpointSet } from "./endpoints.js";
import type {
  AdminSubject,
  AftersaleDetail,
  AftersalePolicy,
  AftersalePolicyPayload,
  AftersaleSummary,
  AgentToken,
  CategoryNode,
  IssuedAgentToken,
  IssueAgentTokenPayload,
  LoginResult,
  MerchantSummary,
  OrderDetail,
  OrderSummary,
  ProductSummary,
  StoreSummary,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* 会话（docs/09 §9.1）                                                        */
/* -------------------------------------------------------------------------- */

/** 登录参数。 */
export interface LoginPayload {
  readonly username: string;
  readonly password: string;
  /** TOTP 动态验证码（平台管理员强制，`docs/M0-实施简报` §6.1）。 */
  readonly totpCode?: string;
}

/**
 * 登录。
 *
 * ⚠️ 路径按入口区分：平台 `POST /api/v1/admin/login`，商户 `POST /api/v1/merchant/login`
 * （`docs/03` §3.5.2 表格：登录接口不同、`aud` 不同、权限集不同）。
 */
export function login(isPlatform: boolean, payload: LoginPayload): Promise<LoginResult> {
  const path = isPlatform ? ADMIN_ENDPOINTS.LOGIN : MERCHANT_ENDPOINTS.LOGIN;
  return post<LoginResult>(path, payload);
}

/** 取当前身份与权限点（页面刷新后恢复会话）。 */
export function fetchMe(isPlatform: boolean): Promise<AdminSubject> {
  const path = isPlatform ? ADMIN_ENDPOINTS.ME : MERCHANT_ENDPOINTS.ME;
  return get<AdminSubject>(path);
}

/** 退出登录（吊销 refresh 并清 Cookie）。 */
export function logout(isPlatform: boolean): Promise<{ loggedOut: boolean }> {
  const path = isPlatform ? ADMIN_ENDPOINTS.LOGOUT : MERCHANT_ENDPOINTS.LOGOUT;
  return post<{ loggedOut: boolean }>(path);
}

/* -------------------------------------------------------------------------- */
/* ★ Agent 服务令牌（PiEcho 运营入口，docs/07 §7.8.1）                          */
/* -------------------------------------------------------------------------- */

/** 令牌列表。 */
export function listAgentTokens(
  endpoints: PlatformEndpointSet,
  signal?: AbortSignal,
): Promise<{ page: number; pageSize: number; total: number; list: AgentToken[] }> {
  return getPage<AgentToken>(endpoints.AGENT_TOKENS, undefined, signal);
}

/**
 * ★ 签发令牌（`POST /api/v1/admin/agent-tokens`）。
 *
 * 响应中的 `token` 是**明文，仅此一次**（服务端只存 HMAC 哈希）——页面必须
 * 让用户当场复制，关闭后不可再取。
 */
export function issueAgentToken(
  endpoints: PlatformEndpointSet,
  payload: IssueAgentTokenPayload,
): Promise<IssuedAgentToken> {
  return post<IssuedAgentToken>(endpoints.AGENT_TOKENS, {
    name: payload.name,
    scopes: payload.scopes,
    expiresInDays: payload.expiresInDays,
    // 强制 TOTP 二次确认（docs/09 §9.2 / docs/M0-实施简报 §4.3）
    totpCode: payload.totpCode,
  });
}

/** 吊销令牌（`POST /api/v1/admin/agent-tokens/:id/revoke`，立即生效）。 */
export function revokeAgentToken(
  endpoints: PlatformEndpointSet,
  id: string,
): Promise<{ id: string; status: string; revokedAt: string }> {
  return post<{ id: string; status: string; revokedAt: string }>(endpoints.AGENT_TOKEN_REVOKE(id));
}

/* -------------------------------------------------------------------------- */
/* ★ 售后政策（PiEcho 政策语料唯一维护入口，docs/07 §7.7）                      */
/* -------------------------------------------------------------------------- */

/** 政策列表。 */
export function listAftersalePolicies(
  endpoints: PlatformEndpointSet,
  signal?: AbortSignal,
): Promise<{ page: number; pageSize: number; total: number; list: AftersalePolicy[] }> {
  return getPage<AftersalePolicy>(endpoints.AFTERSALE_POLICIES, undefined, signal);
}

/**
 * ★ 新建 / 更新政策（`POST /api/v1/admin/aftersale-policies`）。
 *
 * 发布后后端**主动失效 `/policies/*` 边缘缓存**，PiEcho 按 `contentHash` 自动感知
 * （`docs/07` §7.7 / §7.10）——不需要通知 PiEcho 改配置。
 */
export function saveAftersalePolicy(
  endpoints: PlatformEndpointSet,
  payload: AftersalePolicyPayload,
): Promise<AftersalePolicy> {
  return post<AftersalePolicy>(endpoints.AFTERSALE_POLICIES, payload);
}

/* -------------------------------------------------------------------------- */
/* 订单 / 售后 / 商品 / 商户 / 门店                                             */
/* -------------------------------------------------------------------------- */

/** 订单列表。 */
export function listOrders(
  isPlatform: boolean,
  query: { page?: number; pageSize?: number; status?: string; orderNo?: string },
  signal?: AbortSignal,
): Promise<{ page: number; pageSize: number; total: number; list: OrderSummary[] }> {
  const path = isPlatform ? ADMIN_ENDPOINTS.ORDERS : MERCHANT_ENDPOINTS.ORDERS;
  return getPage<OrderSummary>(path, query, signal);
}

/** 订单详情（主单 + 子单状态）。 */
export function getOrderDetail(
  isPlatform: boolean,
  orderNo: string,
  signal?: AbortSignal,
): Promise<OrderDetail> {
  const path = isPlatform
    ? ADMIN_ENDPOINTS.ORDER_DETAIL(orderNo)
    : MERCHANT_ENDPOINTS.ORDER_DETAIL(orderNo);
  return get<OrderDetail>(path, undefined, signal);
}

/** 售后单列表。 */
export function listAftersales(
  isPlatform: boolean,
  query: { page?: number; pageSize?: number; status?: string },
  signal?: AbortSignal,
): Promise<{ page: number; pageSize: number; total: number; list: AftersaleSummary[] }> {
  const path = isPlatform ? ADMIN_ENDPOINTS.AFTERSALES : MERCHANT_ENDPOINTS.AFTERSALES;
  return getPage<AftersaleSummary>(path, query, signal);
}

/** 售后单详情（含 `aftersale_logs` 时间线）。 */
export function getAftersaleDetail(
  isPlatform: boolean,
  aftersaleNo: string,
  signal?: AbortSignal,
): Promise<AftersaleDetail> {
  const path = isPlatform
    ? ADMIN_ENDPOINTS.AFTERSALE_DETAIL(aftersaleNo)
    : MERCHANT_ENDPOINTS.AFTERSALE_DETAIL(aftersaleNo);
  return get<AftersaleDetail>(path, undefined, signal);
}

/** 商品列表（只读）。 */
export function listProducts(
  isPlatform: boolean,
  query: { page?: number; pageSize?: number; status?: string; q?: string },
  signal?: AbortSignal,
): Promise<{ page: number; pageSize: number; total: number; list: ProductSummary[] }> {
  const path = isPlatform ? ADMIN_ENDPOINTS.PRODUCTS : MERCHANT_ENDPOINTS.PRODUCTS;
  return getPage<ProductSummary>(path, query, signal);
}

/** 分类列表（只读）。 */
export function listCategories(
  isPlatform: boolean,
  signal?: AbortSignal,
): Promise<{ page: number; pageSize: number; total: number; list: CategoryNode[] }> {
  const path = isPlatform ? ADMIN_ENDPOINTS.CATEGORIES : MERCHANT_ENDPOINTS.CATEGORIES;
  return getPage<CategoryNode>(path, undefined, signal);
}

/** 商户列表（只读）。 */
export function listMerchants(
  isPlatform: boolean,
  signal?: AbortSignal,
): Promise<{ page: number; pageSize: number; total: number; list: MerchantSummary[] }> {
  const path = isPlatform ? ADMIN_ENDPOINTS.MERCHANTS : MERCHANT_ENDPOINTS.MERCHANTS;
  return getPage<MerchantSummary>(path, undefined, signal);
}

/** 门店 / 仓库列表（只读）。 */
export function listStores(
  isPlatform: boolean,
  signal?: AbortSignal,
): Promise<{ page: number; pageSize: number; total: number; list: StoreSummary[] }> {
  const path = isPlatform ? ADMIN_ENDPOINTS.STORES : MERCHANT_ENDPOINTS.STORES;
  return getPage<StoreSummary>(path, undefined, signal);
}

/** 更新政策时复用 PUT（后端若只提供 POST，可在 `saveAftersalePolicy` 内切换）。 */
export function updateAftersalePolicy(
  endpoints: PlatformEndpointSet,
  id: string,
  payload: AftersalePolicyPayload,
): Promise<AftersalePolicy> {
  return put<AftersalePolicy>(`${endpoints.AFTERSALE_POLICIES}/${encodeURIComponent(id)}`, payload);
}
