/**
 * C 端商城契约（`/api/v1/shop/*`，契约中心，零业务逻辑）。
 *
 * 权威来源：
 * - `docs/06-API路由命名空间.md` §6（五组命名空间、统一响应体、统一分页、`Idempotency-Key`）
 * - `docs/03-工程结构与前端.md` §3.5.1（C 端页面清单）
 * - `docs/05-数据模型.md` §5.2–§5.3（字段与金额 / 时间口径）
 * - `docs/08-核心业务流程.md` §8.2–§8.4（下单支付、订单状态机、售后流程）
 * - `docs/09-认证权限与部署.md` §9.1（Cookie JWT，`aud=shop`）
 *
 * 端点清单**逐条对齐** `apps/storefront/src/api/client.ts` 的 JSDoc；本文件的 `path`
 * 是**相对 `/api/v1`** 的模板形式（如 `/shop/orders/:orderNo`），完整路径由
 * `SHOP_ROUTE_PREFIX + path` 得到。
 *
 * ⚠️ 本组错误码为**字符串**（`SHOP_ERROR_CODES`，`ERR_SHOP_*`），与 Agent 组的整数码
 * 严格分离（`docs/README.md:34`、`docs/06:20`）。
 *
 * ⚠️ 与 Agent 契约（`./agent.js`）的差异：C 端是数据归属方本人，`receiver` 等字段
 * **下发未脱敏形态**——脱敏约束只针对 Agent 面（07 §7.8.2）。
 */

import { z } from "zod";
import {
  AFTERSALE_STATUS,
  AFTERSALE_TYPE,
  AftersaleActorSchema,
  AftersaleStatusSchema,
  AftersaleTypeSchema,
  CurrencySchema,
  ORDER_STATUS,
  OrderChannelSchema,
  OrderStatusSchema,
  PaymentChannelSchema,
  SUB_ORDER_STATUS,
  SkuStatusSchema,
  SubOrderStatusSchema,
} from "../enums.js";
import {
  AftersaleNoSchema,
  OrderNoSchema,
  PayNoSchema,
  SubOrderNoSchema,
  UlidSchema,
} from "../ids.js";
import {
  ExpressSchema,
  HTTP_METHOD,
  IsoDateTimeSchema,
  MaskedPhoneSchema,
  MoneySchema,
  OrderItemSchema,
  PageQuerySchema,
  ShipFromSchema,
  SkuSpecSchema,
  pageResultSchema,
} from "./common.js";
import type { HttpMethod } from "./common.js";

export {
  AFTERSALE_STATUS,
  AFTERSALE_TYPE,
  AftersaleStatusSchema,
  AftersaleTypeSchema,
  CurrencySchema,
  ORDER_STATUS,
  OrderStatusSchema,
  SUB_ORDER_STATUS,
  SubOrderStatusSchema,
};

/* -------------------------------------------------------------------------- */
/* 浏览：商品与分类（`docs/03` §3.5.1 首页 / 分类 / 搜索 / 详情）                */
/* -------------------------------------------------------------------------- */

/** 商品参数（`product_attrs`，与 Agent `/specs` 同源同 Schema）。 */
export const ShopProductAttrSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});

/** 参数分组（`product_attrs.group_name`）。 */
export const ShopProductAttrGroupSchema = z.object({
  name: z.string().min(1),
  attrs: z.array(ShopProductAttrSchema),
});

/** 详情页 SKU（含可售库存数值）。 */
export const ShopProductSkuSchema = z.object({
  skuId: UlidSchema,
  skuCode: z.string().min(1),
  spec: SkuSpecSchema,
  price: MoneySchema,
  /** 可售库存 = `stock - locked_stock`（05 §5.3①）。 */
  stock: z.number().int().nonnegative(),
  status: SkuStatusSchema,
});

/** 商品列表项（首页 / 分类 / 搜索共用）。 */
export const ShopProductSummarySchema = z.object({
  spuId: UlidSchema,
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  brand: z.string().nullable(),
  mainImage: z.string().nullable(),
  /** 起售价（分）。 */
  price: MoneySchema,
  currency: CurrencySchema,
  status: z.string().min(1),
});

/** 商品详情页。 */
export const ShopProductDetailSchema = ShopProductSummarySchema.extend({
  /** 富文本详情（`products.detail_html`）。 */
  description: z.string().nullable(),
  attrGroups: z.array(ShopProductAttrGroupSchema),
  skus: z.array(ShopProductSkuSchema),
});

/** 分类树节点（`categories`，`parentId` 为 `null` 即根）。 */
export interface ShopCategoryNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly children: readonly ShopCategoryNode[];
}

/** 分类树节点 Schema（自引用，故用 `z.lazy`）。 */
export const ShopCategoryNodeSchema: z.ZodType<ShopCategoryNode> = z.lazy(() =>
  z.object({
    id: UlidSchema,
    name: z.string().min(1),
    parentId: UlidSchema.nullable(),
    children: z.array(ShopCategoryNodeSchema),
  }),
);

/** `GET /shop/products` 查询参数。 */
export const ShopProductListQuerySchema = PageQuerySchema.extend({
  categoryId: UlidSchema.optional(),
  /** 关键词（标题 / 品牌模糊匹配）。 */
  q: z.string().trim().max(64, "关键词过长").optional(),
  /** 排序标识（如 `price_asc` / `sales_desc`），取值由前端与后端约定。 */
  sort: z.string().min(1).optional(),
});

/** `GET /shop/products` 的 `data`。 */
export const ShopProductListSchema = pageResultSchema(ShopProductSummarySchema);

/** `GET /shop/products/:spuId` 的路径参数。 */
export const ShopProductDetailParamsSchema = z.object({ spuId: UlidSchema });

/* -------------------------------------------------------------------------- */
/* 购物车与结算                                                                */
/* -------------------------------------------------------------------------- */

/** 购物车行。 */
export const ShopCartItemSchema = z.object({
  id: UlidSchema,
  skuId: UlidSchema,
  spuId: UlidSchema,
  title: z.string().min(1),
  spec: SkuSpecSchema,
  unitPrice: MoneySchema,
  quantity: z.number().int().positive(),
  subtotal: MoneySchema,
  /** 是否仍可购买（下架 / 售罄为 `false`，结算前必须剔除）。 */
  available: z.boolean(),
});

/** 购物车聚合（`GET /shop/cart` 的 `data`，也是三个写接口的响应）。 */
export const ShopCartSchema = z.object({
  items: z.array(ShopCartItemSchema),
  totalAmount: MoneySchema,
  currency: CurrencySchema,
});

/** `POST /shop/cart/items` 请求体。 */
export const ShopCartItemAddBodySchema = z.object({
  skuId: UlidSchema,
  quantity: z.number().int().positive("数量须为正整数"),
});

/** `PUT /shop/cart/items/:id` 路径参数。 */
export const ShopCartItemParamsSchema = z.object({ id: UlidSchema });

/**
 * `PUT /shop/cart/items/:id` 请求体。
 *
 * `quantity = 0` 的语义是**删除该行**（见 `apps/storefront/src/api/client.ts` 的 JSDoc），
 * 因此下界为 `0` 而非 `1`。
 */
export const ShopCartItemUpdateBodySchema = z.object({
  quantity: z.number().int().nonnegative("数量不能为负"),
});

/** `GET /shop/checkout/preview` 查询参数。 */
export const ShopCheckoutPreviewQuerySchema = z.object({
  addressId: UlidSchema.optional(),
  /** 待结算的购物车行 id，**逗号分隔**（前端以 `join(",")` 拼接）。 */
  itemIds: z.string().optional(),
});

/** 结算页的单个商户分组（按 `merchant_id` 拆分，`docs/03` §3.5.1）。 */
export const ShopCheckoutGroupSchema = z.object({
  merchantId: UlidSchema,
  merchantName: z.string().min(1),
  items: z.array(ShopCartItemSchema),
  goodsAmount: MoneySchema,
  freightAmount: MoneySchema,
});

/** `GET /shop/checkout/preview` 的 `data`。 */
export const ShopCheckoutPreviewSchema = z.object({
  groups: z.array(ShopCheckoutGroupSchema),
  goodsAmount: MoneySchema,
  freightAmount: MoneySchema,
  discountAmount: MoneySchema,
  payAmount: MoneySchema,
  currency: CurrencySchema,
});

/* -------------------------------------------------------------------------- */
/* 地址簿（`user_addresses`）                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 收货地址条目。
 *
 * C 端是地址归属方本人，故 `receiverName` / `receiverPhone` / `detail` **完整下发**；
 * 库内 `receiver_phone` 为加密列，由服务层解密后返回（05 §5.2）。
 */
export const ShopAddressSchema = z.object({
  id: UlidSchema,
  receiverName: z.string().min(1),
  receiverPhone: z.string().min(1),
  province: z.string().min(1),
  city: z.string().min(1),
  district: z.string().min(1),
  detail: z.string().min(1),
  isDefault: z.boolean(),
});

/** `GET /shop/addresses` 的 `data`。 */
export const ShopAddressListSchema = z.array(ShopAddressSchema);

/* -------------------------------------------------------------------------- */
/* 订单（主单 + 子单，两者都必须下发 —— `docs/08` §8.3）                        */
/* -------------------------------------------------------------------------- */

/** 子单（含物流与商品快照）。 */
export const ShopSubOrderSchema = z.object({
  subOrderNo: SubOrderNoSchema,
  merchantName: z.string().min(1),
  merchantType: z.string().min(1),
  status: SubOrderStatusSchema,
  statusText: z.string().min(1),
  /** 发货地（来自 `sub_orders.store_id` → `stores`）。 */
  shipFrom: ShipFromSchema,
  /** 未发货时为 `null`。 */
  express: ExpressSchema.nullable(),
  items: z.array(OrderItemSchema).min(1),
});

/** 未脱敏收件人（C 端专用）。 */
export const ShopOrderReceiverSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  province: z.string().min(1),
  city: z.string().min(1),
  district: z.string().min(1),
  detail: z.string().min(1),
});

/** 主单维度售后汇总。 */
export const ShopOrderAftersaleSummarySchema = z.object({
  hasAftersale: z.boolean(),
  openCount: z.number().int().nonnegative(),
  refundedAmount: MoneySchema,
});

/** 主单详情（`GET /shop/orders/:orderNo` 的 `data`）。 */
export const ShopOrderDetailSchema = z.object({
  orderNo: OrderNoSchema,
  status: OrderStatusSchema,
  statusText: z.string().min(1),
  channel: OrderChannelSchema,
  createdAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
  payAmount: MoneySchema,
  currency: CurrencySchema,
  receiver: ShopOrderReceiverSchema,
  subOrders: z.array(ShopSubOrderSchema).min(1),
  aftersaleSummary: ShopOrderAftersaleSummarySchema,
});

/** 订单列表项（`GET /shop/orders` 的 `list[]`）。 */
export const ShopOrderListItemSchema = z.object({
  orderNo: OrderNoSchema,
  status: OrderStatusSchema,
  statusText: z.string().min(1),
  payAmount: MoneySchema,
  itemSummary: z.string().min(1),
  itemCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  subOrderCount: z.number().int().positive(),
  allShipped: z.boolean(),
  hasOpenAftersale: z.boolean(),
});

/** `GET /shop/orders` 查询参数。 */
export const ShopOrderListQuerySchema = PageQuerySchema.extend({
  status: OrderStatusSchema.optional(),
});

/** `GET /shop/orders` 的 `data`。 */
export const ShopOrderListSchema = pageResultSchema(ShopOrderListItemSchema);

/**
 * `POST /shop/orders` 请求体。
 *
 * ⚠️ 该端点**必须**携带 `Idempotency-Key` 请求头（`docs/06` §6），否则重复提交会重复下单。
 */
export const ShopOrderCreateBodySchema = z.object({
  addressId: UlidSchema,
  /** 待结算的购物车行 id；省略表示「整车结算」。 */
  itemIds: z.array(UlidSchema).optional(),
  remark: z.string().trim().max(200, "备注过长").optional(),
});

/** `GET /shop/orders/:orderNo` 与 `POST /shop/orders/:orderNo/pay` 的路径参数。 */
export const ShopOrderParamsSchema = z.object({ orderNo: OrderNoSchema });

/** `POST /shop/orders/:orderNo/pay` 请求体。 */
export const ShopOrderPayBodySchema = z.object({
  /** 支付渠道；同一接口按 `channel` 返回不同封装参数（`docs/08` §8.2）。 */
  channel: PaymentChannelSchema,
});

/** `POST /shop/orders/:orderNo/pay` 的 `data`（按渠道封装的支付参数）。 */
export const ShopOrderPayResultSchema = z.object({
  payNo: PayNoSchema,
  channel: PaymentChannelSchema,
  /** 渠道参数键值对（扫码串 / JSAPI 参数 / 跳转表单字段）。 */
  params: z.record(z.string(), z.string()),
});

/* -------------------------------------------------------------------------- */
/* 售后（`docs/08` §8.4）                                                      */
/* -------------------------------------------------------------------------- */

/** 售后时间线节点（`aftersale_logs` 的展示形态）。 */
export const ShopAftersaleTimelineEntrySchema = z.object({
  at: IsoDateTimeSchema,
  actor: AftersaleActorSchema,
  from: AftersaleStatusSchema.nullable(),
  to: AftersaleStatusSchema,
  remark: z.string().nullable(),
});

/** 退款信息。 */
export const ShopAftersaleRefundSchema = z.object({
  status: z.string().min(1),
  refundNo: z.string().nullable(),
  channel: z.string().nullable(),
  arrivedAt: IsoDateTimeSchema.nullable(),
  estimatedArrivalDays: z.number().int().nonnegative().nullable(),
});

/** 回寄物流（买家填写后才有值）。 */
export const ShopReturnExpressSchema = z.object({
  company: z.string().min(1),
  no: z.string().min(1),
  shippedAt: IsoDateTimeSchema.nullable(),
});

/** 售后详情（C 端，含**未脱敏**回寄地址）。 */
export const ShopAftersaleDetailSchema = z.object({
  aftersaleNo: AftersaleNoSchema,
  type: AftersaleTypeSchema,
  typeText: z.string().min(1),
  status: AftersaleStatusSchema,
  statusText: z.string().min(1),
  orderNo: OrderNoSchema,
  subOrderNo: SubOrderNoSchema,
  skuId: UlidSchema,
  itemTitle: z.string().min(1),
  quantity: z.number().int().positive(),
  refundAmount: MoneySchema,
  currency: CurrencySchema,
  reason: z.string().nullable(),
  /** 仅下发**凭证数量**，凭证对象键不下发（与 Agent 面一致的口径）。 */
  evidenceCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  deadlineAt: IsoDateTimeSchema.nullable(),
  returnAddress: ShopOrderReceiverSchema.nullable(),
  returnExpress: ShopReturnExpressSchema.nullable(),
  refund: ShopAftersaleRefundSchema,
  timeline: z.array(ShopAftersaleTimelineEntrySchema),
});

/** 售后列表项。 */
export const ShopAftersaleListItemSchema = z.object({
  aftersaleNo: AftersaleNoSchema,
  orderNo: OrderNoSchema,
  type: AftersaleTypeSchema,
  typeText: z.string().min(1),
  status: AftersaleStatusSchema,
  statusText: z.string().min(1),
  itemTitle: z.string().min(1),
  refundAmount: MoneySchema,
  createdAt: IsoDateTimeSchema,
});

/**
 * `POST /shop/aftersales` 请求体（仅退款 / 退货退款 + 凭证）。
 *
 * ⚠️ 该端点同样**必须**携带 `Idempotency-Key`（`apps/storefront/src/api/client.ts`
 * 的 `applyAftersale(input, idempotencyKey)`）。
 */
export const ShopAftersaleApplyBodySchema = z.object({
  orderNo: OrderNoSchema,
  subOrderNo: SubOrderNoSchema,
  skuId: UlidSchema,
  quantity: z.number().int().positive("数量须为正整数"),
  type: AftersaleTypeSchema,
  reason: z.string().trim().min(1, "请填写售后原因").max(500, "原因过长"),
  /** 凭证对象键（预签名直传 R2 后的 key，`docs/03` §3.5.1）。 */
  evidenceKeys: z.array(z.string().min(1)).optional(),
});

/** `GET /shop/aftersales` 查询参数。 */
export const ShopAftersaleListQuerySchema = PageQuerySchema.extend({
  status: AftersaleStatusSchema.optional(),
});

/** `GET /shop/aftersales` 的 `data`。 */
export const ShopAftersaleListSchema = pageResultSchema(ShopAftersaleListItemSchema);

/** `GET /shop/aftersales/:aftersaleNo` 的路径参数。 */
export const ShopAftersaleParamsSchema = z.object({ aftersaleNo: AftersaleNoSchema });

/* -------------------------------------------------------------------------- */
/* 会员认证（手机号 + 短信验证码，`docs/08` §8.1）                              */
/* -------------------------------------------------------------------------- */

/** 手机号（中国大陆 11 位，`1` 开头）。 */
export const ShopPhoneSchema = z.string().regex(/^1\d{10}$/, "手机号须为 11 位且以 1 开头");

/** `POST /shop/auth/sms-code` 请求体。 */
export const ShopSmsCodeBodySchema = z.object({ phone: ShopPhoneSchema });

/** `POST /shop/auth/sms-code` 的 `data`（`docs/08` §8.1：60s 冷却）。 */
export const ShopSmsCodeResultSchema = z.object({
  expiresInSeconds: z.number().int().positive(),
});

/** `POST /shop/auth/login` 请求体。 */
export const ShopLoginBodySchema = z.object({
  phone: ShopPhoneSchema,
  code: z.string().regex(/^\d{4,6}$/, "验证码须为 4–6 位数字"),
});

/** 登录态用户（`aud=shop`，`docs/09` §9.1）。 */
export const ShopUserSchema = z.object({
  userId: UlidSchema,
  nickname: z.string().nullable(),
  phoneMasked: MaskedPhoneSchema,
});

/** `POST /shop/auth/logout` 的 `data`（无载荷，固定 `null`）。 */
export const ShopLogoutResultSchema = z.null();

/* -------------------------------------------------------------------------- */
/* 端点清单（供路由注册与契约测试共用）                                        */
/* -------------------------------------------------------------------------- */

/** shop 端点规格：方法 + 路径模板 + 请求 / 响应 Schema。 */
export interface ShopEndpointSpec {
  /** HTTP 方法。 */
  readonly method: HttpMethod;
  /** 路径模板（**相对 `/api/v1`**，`:name` 为路径参数）。 */
  readonly path: string;
  /** 查询参数 Schema；无查询参数时为 `null`。 */
  readonly querySchema: z.ZodType | null;
  /** 请求体 Schema；无请求体时为 `null`。 */
  readonly bodySchema: z.ZodType | null;
  /** 统一响应体 `data` 的 Schema。 */
  readonly responseSchema: z.ZodType;
  /** 是否**必须**携带 `Idempotency-Key` 请求头（`docs/06` §6）。 */
  readonly idempotencyKeyRequired: boolean;
}

/**
 * shop 组端点全集。
 *
 * 每项一条，`path` 与 `apps/storefront/src/api/client.ts` 的 JSDoc **逐字对应**
 * （去掉 `/api/v1` 前缀）。
 */
export const SHOP_ENDPOINTS = {
  /** `GET /api/v1/shop/products?categoryId=&q=&sort=&page=`（首页 / 分类 / 搜索共用）。 */
  LIST_PRODUCTS: {
    method: HTTP_METHOD.GET,
    path: "/shop/products",
    querySchema: ShopProductListQuerySchema,
    bodySchema: null,
    responseSchema: ShopProductListSchema,
    idempotencyKeyRequired: false,
  },
  /** `GET /api/v1/shop/categories` —— `categories` 树。 */
  LIST_CATEGORIES: {
    method: HTTP_METHOD.GET,
    path: "/shop/categories",
    querySchema: null,
    bodySchema: null,
    responseSchema: z.array(ShopCategoryNodeSchema),
    idempotencyKeyRequired: false,
  },
  /** `GET /api/v1/shop/products/:spuId` —— 规格 / 参数与 Agent `/specs` 同源同 Schema。 */
  GET_PRODUCT: {
    method: HTTP_METHOD.GET,
    path: "/shop/products/:spuId",
    querySchema: null,
    bodySchema: null,
    responseSchema: ShopProductDetailSchema,
    idempotencyKeyRequired: false,
  },
  /** `GET /api/v1/shop/cart`。 */
  GET_CART: {
    method: HTTP_METHOD.GET,
    path: "/shop/cart",
    querySchema: null,
    bodySchema: null,
    responseSchema: ShopCartSchema,
    idempotencyKeyRequired: false,
  },
  /** `POST /api/v1/shop/cart/items` `{ skuId, quantity }`。 */
  ADD_CART_ITEM: {
    method: HTTP_METHOD.POST,
    path: "/shop/cart/items",
    querySchema: null,
    bodySchema: ShopCartItemAddBodySchema,
    responseSchema: ShopCartSchema,
    idempotencyKeyRequired: false,
  },
  /** `PUT /api/v1/shop/cart/items/:id` —— 改数量（`quantity=0` 语义为删除）。 */
  UPDATE_CART_ITEM: {
    method: HTTP_METHOD.PUT,
    path: "/shop/cart/items/:id",
    querySchema: null,
    bodySchema: ShopCartItemUpdateBodySchema,
    responseSchema: ShopCartSchema,
    idempotencyKeyRequired: false,
  },
  /** `DELETE /api/v1/shop/cart/items/:id`。 */
  REMOVE_CART_ITEM: {
    method: HTTP_METHOD.DELETE,
    path: "/shop/cart/items/:id",
    querySchema: null,
    bodySchema: null,
    responseSchema: ShopCartSchema,
    idempotencyKeyRequired: false,
  },
  /** `GET /api/v1/shop/checkout/preview` —— 地址 / 优惠券 / 运费试算。 */
  PREVIEW_CHECKOUT: {
    method: HTTP_METHOD.GET,
    path: "/shop/checkout/preview",
    querySchema: ShopCheckoutPreviewQuerySchema,
    bodySchema: null,
    responseSchema: ShopCheckoutPreviewSchema,
    idempotencyKeyRequired: false,
  },
  /** `GET /api/v1/shop/addresses` —— 地址簿（`user_addresses`）。 */
  LIST_ADDRESSES: {
    method: HTTP_METHOD.GET,
    path: "/shop/addresses",
    querySchema: null,
    bodySchema: null,
    responseSchema: ShopAddressListSchema,
    idempotencyKeyRequired: false,
  },
  /** `POST /api/v1/shop/orders`（`docs/06` §6：**必须**带 `Idempotency-Key`）。 */
  CREATE_ORDER: {
    method: HTTP_METHOD.POST,
    path: "/shop/orders",
    querySchema: null,
    bodySchema: ShopOrderCreateBodySchema,
    responseSchema: ShopOrderDetailSchema,
    idempotencyKeyRequired: true,
  },
  /** `POST /api/v1/shop/orders/:orderNo/pay` —— 返回按渠道封装的支付参数。 */
  PAY_ORDER: {
    method: HTTP_METHOD.POST,
    path: "/shop/orders/:orderNo/pay",
    querySchema: null,
    bodySchema: ShopOrderPayBodySchema,
    responseSchema: ShopOrderPayResultSchema,
    idempotencyKeyRequired: false,
  },
  /** `GET /api/v1/shop/orders?status=&page=&pageSize=`。 */
  LIST_ORDERS: {
    method: HTTP_METHOD.GET,
    path: "/shop/orders",
    querySchema: ShopOrderListQuerySchema,
    bodySchema: null,
    responseSchema: ShopOrderListSchema,
    idempotencyKeyRequired: false,
  },
  /** `GET /api/v1/shop/orders/:orderNo` —— 返回**主单 + 子单**（`docs/08` §8.3）。 */
  GET_ORDER: {
    method: HTTP_METHOD.GET,
    path: "/shop/orders/:orderNo",
    querySchema: null,
    bodySchema: null,
    responseSchema: ShopOrderDetailSchema,
    idempotencyKeyRequired: false,
  },
  /** `POST /api/v1/shop/aftersales` —— 仅退款 / 退货退款 + 凭证（需幂等键）。 */
  CREATE_AFTERSALE: {
    method: HTTP_METHOD.POST,
    path: "/shop/aftersales",
    querySchema: null,
    bodySchema: ShopAftersaleApplyBodySchema,
    responseSchema: ShopAftersaleDetailSchema,
    idempotencyKeyRequired: true,
  },
  /** `GET /api/v1/shop/aftersales?page=&pageSize=`。 */
  LIST_AFTERSALES: {
    method: HTTP_METHOD.GET,
    path: "/shop/aftersales",
    querySchema: ShopAftersaleListQuerySchema,
    bodySchema: null,
    responseSchema: ShopAftersaleListSchema,
    idempotencyKeyRequired: false,
  },
  /** `GET /api/v1/shop/aftersales/:aftersaleNo` —— 时间线取 `aftersale_logs`。 */
  GET_AFTERSALE: {
    method: HTTP_METHOD.GET,
    path: "/shop/aftersales/:aftersaleNo",
    querySchema: null,
    bodySchema: null,
    responseSchema: ShopAftersaleDetailSchema,
    idempotencyKeyRequired: false,
  },
  /** `POST /api/v1/shop/auth/sms-code` —— 手机号 + 短信验证码登录（`docs/08` §8.1）。 */
  SEND_SMS_CODE: {
    method: HTTP_METHOD.POST,
    path: "/shop/auth/sms-code",
    querySchema: null,
    bodySchema: ShopSmsCodeBodySchema,
    responseSchema: ShopSmsCodeResultSchema,
    idempotencyKeyRequired: false,
  },
  /** `POST /api/v1/shop/auth/login` —— 成功后 Set-Cookie（HttpOnly，`aud=shop`）。 */
  LOGIN: {
    method: HTTP_METHOD.POST,
    path: "/shop/auth/login",
    querySchema: null,
    bodySchema: ShopLoginBodySchema,
    responseSchema: ShopUserSchema,
    idempotencyKeyRequired: false,
  },
  /** `POST /api/v1/shop/auth/logout`。 */
  LOGOUT: {
    method: HTTP_METHOD.POST,
    path: "/shop/auth/logout",
    querySchema: null,
    bodySchema: null,
    responseSchema: ShopLogoutResultSchema,
    idempotencyKeyRequired: false,
  },
  /** `GET /api/v1/shop/auth/me` —— 当前登录态（`401` + `ERR_SHOP_*` 表示未登录）。 */
  GET_ME: {
    method: HTTP_METHOD.GET,
    path: "/shop/auth/me",
    querySchema: null,
    bodySchema: null,
    responseSchema: ShopUserSchema,
    idempotencyKeyRequired: false,
  },
} as const satisfies Record<string, ShopEndpointSpec>;

/** shop 组端点列表（路由注册与契约测试共用）。 */
export const SHOP_ENDPOINT_LIST: readonly ShopEndpointSpec[] = Object.values(SHOP_ENDPOINTS);

/** shop 路由前缀（`docs/06` §6：`/api/v1/shop/...`）。 */
export const SHOP_ROUTE_PREFIX = "/api/v1/shop";
