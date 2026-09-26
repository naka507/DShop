/**
 * shop 组接口封装（`docs/06-API路由命名空间.md` §6）。
 *
 * 每个函数对应一个后端端点，返回值是**统一响应体里的 `data`**（已解包）。
 * 页面只调用本模块，不直接拼 URL——这样「相对路径」「统一响应体」「错误码分流」
 * 三条约束只有一处实现。
 *
 * 端点清单来自 `docs/06` §6 的路由示例与 `docs/03` §3.5.1 的页面清单；
 * 后端尚未实现的端点在文件末尾单独标注（页面需容忍 404）。
 */

import { resolveRequester } from "./api-client-adapter.ts";
import type { Requester } from "./transport.ts";
import type { PageResult } from "./transport.ts";
import type {
  AddressView,
  AftersaleApplyInput,
  AftersaleDetailView,
  AftersaleListItemView,
  CartView,
  CategoryNode,
  CheckoutPreview,
  OrderDetailView,
  OrderListItemView,
  ProductDetail,
  ProductSummary,
  ShopUser,
} from "./types.ts";

/** 请求器（默认由 `@dshop/api-client` 或本地 transport 提供，可注入以便测试）。 */
export const requester: Requester = resolveRequester();

/* -------------------------------------------------------------------------- */
/* 浏览（SSR/CSR 只读，`docs/03` §3.5.1）                                      */
/* -------------------------------------------------------------------------- */

/** `GET /api/v1/shop/products?categoryId=&q=&sort=&page=`（首页 / 分类 / 搜索共用）。 */
export function listProducts(
  params: {
    readonly categoryId?: string;
    readonly q?: string;
    readonly sort?: string;
    readonly page?: number;
    readonly pageSize?: number;
  } = {},
): Promise<PageResult<ProductSummary>> {
  return requester<PageResult<ProductSummary>>("/products", { query: params });
}

/** `GET /api/v1/shop/categories` —— `categories` 树。 */
export function listCategories(): Promise<readonly CategoryNode[]> {
  return requester<readonly CategoryNode[]>("/categories");
}

/** `GET /api/v1/shop/products/:spuId` —— 规格/参数与 Agent `/specs` 同源同 Schema。 */
export function getProduct(spuId: string): Promise<ProductDetail> {
  return requester<ProductDetail>(`/products/${encodeURIComponent(spuId)}`);
}

/* -------------------------------------------------------------------------- */
/* 交易                                                                        */
/* -------------------------------------------------------------------------- */

/** `GET /api/v1/shop/cart`。 */
export function getCart(): Promise<CartView> {
  return requester<CartView>("/cart");
}

/** `POST /api/v1/shop/cart/items` `{ skuId, quantity }`。 */
export function addCartItem(skuId: string, quantity: number): Promise<CartView> {
  return requester<CartView>("/cart/items", { method: "POST", body: { skuId, quantity } });
}

/** `PUT /api/v1/shop/cart/items/:id` —— 改数量（`quantity=0` 语义为删除）。 */
export function updateCartItem(itemId: string, quantity: number): Promise<CartView> {
  return requester<CartView>(`/cart/items/${encodeURIComponent(itemId)}`, {
    method: "PUT",
    body: { quantity },
  });
}

/** `DELETE /api/v1/shop/cart/items/:id`。 */
export function removeCartItem(itemId: string): Promise<CartView> {
  return requester<CartView>(`/cart/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

/** `GET /api/v1/shop/checkout/preview` —— 地址/优惠券/运费试算。 */
export function previewCheckout(
  input: {
    readonly addressId?: string;
    readonly itemIds?: readonly string[];
  } = {},
): Promise<CheckoutPreview> {
  return requester<CheckoutPreview>("/checkout/preview", {
    query: { addressId: input.addressId, itemIds: input.itemIds?.join(",") },
  });
}

/** `GET /api/v1/shop/addresses` —— 地址簿（`user_addresses`）。 */
export function listAddresses(): Promise<readonly AddressView[]> {
  return requester<readonly AddressView[]>("/addresses");
}

/**
 * `POST /api/v1/shop/orders`（`docs/06` §6：**必须**带 `Idempotency-Key`）。
 *
 * 幂等键由调用方生成并**在重试间保持不变**，否则会重复下单
 * （`docs/M0-实施简报.md` §5：`DB.batch` 原子批次只锁库存）。
 */
export function createOrder(
  input: {
    readonly addressId: string;
    /** 待结算的购物车行 id 列表；省略表示「整车结算」。 */
    readonly itemIds?: readonly string[];
    readonly remark?: string;
  },
  idempotencyKey: string,
): Promise<OrderDetailView> {
  return requester<OrderDetailView>("/orders", {
    method: "POST",
    body: input,
    idempotencyKey,
  });
}

/** `POST /api/v1/shop/orders/:orderNo/pay` —— 返回按渠道封装的支付参数（§8.2）。 */
export function payOrder(
  orderNo: string,
  channel: string,
): Promise<{
  readonly payNo: string;
  readonly channel: string;
  readonly params: Readonly<Record<string, string>>;
}> {
  return requester(`/orders/${encodeURIComponent(orderNo)}/pay`, {
    method: "POST",
    body: { channel },
  });
}

/* -------------------------------------------------------------------------- */
/* 会员                                                                        */
/* -------------------------------------------------------------------------- */

/** `POST /api/v1/shop/auth/sms-code` —— 手机号 + 短信验证码登录（`docs/03` §3.5.1）。 */
export function sendSmsCode(phone: string): Promise<{ readonly expiresInSeconds: number }> {
  return requester("/auth/sms-code", { method: "POST", body: { phone } });
}

/** `POST /api/v1/shop/auth/login` —— 成功后 Set-Cookie（HttpOnly，`aud=shop`）。 */
export function loginWithSmsCode(phone: string, code: string): Promise<ShopUser> {
  return requester<ShopUser>("/auth/login", { method: "POST", body: { phone, code } });
}

/** `POST /api/v1/shop/auth/logout`。 */
export function logout(): Promise<null> {
  return requester<null>("/auth/logout", { method: "POST" });
}

/** `GET /api/v1/shop/auth/me` —— 当前登录态（`401` + `ERR_SHOP_*` 表示未登录）。 */
export function getCurrentUser(): Promise<ShopUser> {
  return requester<ShopUser>("/auth/me");
}

/** `GET /api/v1/shop/orders?status=&page=&pageSize=`。 */
export function listOrders(
  params: {
    readonly status?: string;
    readonly page?: number;
    readonly pageSize?: number;
  } = {},
): Promise<PageResult<OrderListItemView>> {
  return requester<PageResult<OrderListItemView>>("/orders", { query: params });
}

/**
 * `GET /api/v1/shop/orders/:orderNo`。
 *
 * 返回**主单 + 子单**（`docs/08` §8.3）：客服与用户都需答「买了三件为什么只发一件」，
 * 因此页面必须同时展示两级状态。
 */
export function getOrder(orderNo: string): Promise<OrderDetailView> {
  return requester<OrderDetailView>(`/orders/${encodeURIComponent(orderNo)}`);
}

/* -------------------------------------------------------------------------- */
/* 售后                                                                        */
/* -------------------------------------------------------------------------- */

/** `POST /api/v1/shop/aftersales` —— 仅退款 / 退货退款 + 凭证。 */
export function applyAftersale(
  input: AftersaleApplyInput,
  idempotencyKey: string,
): Promise<AftersaleDetailView> {
  return requester<AftersaleDetailView>("/aftersales", {
    method: "POST",
    body: input,
    idempotencyKey,
  });
}

/** `GET /api/v1/shop/aftersales?page=&pageSize=`。 */
export function listAftersales(
  params: { readonly page?: number; readonly pageSize?: number } = {},
): Promise<PageResult<AftersaleListItemView>> {
  return requester<PageResult<AftersaleListItemView>>("/aftersales", { query: params });
}

/** `GET /api/v1/shop/aftersales/:aftersaleNo` —— 时间线取 `aftersale_logs`。 */
export function getAftersale(aftersaleNo: string): Promise<AftersaleDetailView> {
  return requester<AftersaleDetailView>(`/aftersales/${encodeURIComponent(aftersaleNo)}`);
}

/**
 * `GET /api/v1/agent/policies/:category` —— 售后政策条款。
 *
 * ## 为什么 C 端政策页读的是 **Agent 组**端点
 *
 * `docs/03` §3.5.1 的页面清单里没有政策页；任务要求「展示 `GET /api/v1/agent/policies`
 * 或 shop 组对应端点的内容」。选 Agent 组端点是因为：
 *
 * 1. `aftersale_policies` 的**唯一对外出口**就是 `/agent/policies/{category}`
 *    （`docs/05-数据模型.md`：该表是「Agent `/policies/{category}` 的唯一来源」），
 *    文档未定义 shop 组的政策端点；
 * 2. 该端点返回的是**面向外部的政策全文**（markdown），不含任何用户隐私数据，
 *    因此 C 端公开可读不引入新的暴露面；
 * 3. 走它还能复用 `contentHash`（`docs/07` §7.10）做前端缓存。
 *
 * ⚠️ 但它需要**服务令牌**（`X-Service-Token`，`docs/07` §7.8.1），浏览器侧不应持有。
 * 因此**生产环境必须由 storefront Worker 用 Service Binding 代理**该路径
 * （同源转发，见 `vite.config.ts` 的注释）；dev 下由 Vite 代理直连本地 API，
 * 需要本地 `wrangler dev` 侧配置了令牌。若该端点不可达，政策页展示明确的降级提示，
 * **不伪造政策内容**。
 */
export function getAftersalePolicies(category: string): Promise<{
  readonly category: string;
  readonly contentHash: string;
  readonly items: readonly PolicyItem[];
}> {
  return requester(`/api/v1/agent/policies/${encodeURIComponent(category)}`);
}

/** 政策条款项（`docs/07` §7.7）。 */
export interface PolicyItem {
  readonly policyId: string;
  readonly title: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly updatedAt: string;
  readonly content: string;
  readonly tags: readonly string[];
}
