/**
 * 商户后台契约（`/api/v1/merchant/*`，契约中心，零业务逻辑）。
 *
 * 权威来源：
 * - `docs/06-API路由命名空间.md` §6（五组命名空间、统一响应体、统一分页）
 * - `docs/03-工程结构与前端.md` §3.5.2（商户入口与平台入口：**接口不同、Token `aud` 不同、
 *   权限集不同**）
 * - `docs/09-认证权限与部署.md` §9.1–§9.2（`aud=merchant`、`merchantScope` 行级隔离）
 * - `docs/08-核心业务流程.md` §8.3–§8.4（主单 / 子单状态、售后状态机）
 *
 * 端点清单**逐条对齐** `apps/admin/src/api/endpoints.ts` 的 `MERCHANT_ENDPOINTS`
 * （路径去掉 `/api/v1` 前缀后的模板形式）。
 *
 * ⚠️ 商户侧**没有** Agent 令牌 / 售后政策入口——那两个权限点属平台运营角色（09 §9.2）。
 * 故本文件的端点集**不含** `/admin/agent-tokens`、`/admin/aftersale-policies`。
 *
 * ⚠️ 所有查询自动受 `merchantScope` 行级隔离约束（09 §9.2）：服务端强制注入
 * `merchant_id = 当前商户`，前端传参不参与隔离判定。
 *
 * ⚠️ 本组错误码为**字符串**（`MERCHANT_ERROR_CODES`，`ERR_MERCHANT_*`）。
 */

import { z } from "zod";
import {
  AftersaleStatusSchema,
  AftersaleTypeSchema,
  CurrencySchema,
  MerchantTypeSchema,
  OrderStatusSchema,
  SkuStatusSchema,
  SubOrderStatusSchema,
} from "../enums.js";
import { AftersaleNoSchema, OrderNoSchema, SubOrderNoSchema, UlidSchema } from "../ids.js";
import {
  ExpressSchema,
  HTTP_METHOD,
  IsoDateTimeSchema,
  MoneySchema,
  OrderItemSchema,
  PageQuerySchema,
  ShipFromSchema,
  SkuSpecSchema,
  pageResultSchema,
} from "./common.js";
import type { HttpMethod } from "./common.js";
import { ShopOrderReceiverSchema } from "./shop.js";

/* -------------------------------------------------------------------------- */
/* 会话与身份（`docs/09` §9.1）                                                */
/* -------------------------------------------------------------------------- */

/** `POST /merchant/login` 请求体（账号 + 密码 + 可选 TOTP，`docs/08` §8.1）。 */
export const MerchantLoginBodySchema = z.object({
  username: z.string().trim().min(1, "账号不能为空").max(64, "账号过长"),
  password: z.string().min(1, "密码不能为空").max(128, "密码过长"),
  /** TOTP 动态验证码（商户管理员**可选**启用，`docs/08` §8.1）。 */
  totpCode: z
    .string()
    .regex(/^\d{6}$/, "动态验证码须为 6 位数字")
    .optional(),
});

/** 后台主体（对齐 `apps/admin/src/api/types.ts` 的 `AdminSubject`）。 */
export const MerchantSubjectSchema = z.object({
  id: UlidSchema,
  username: z.string().min(1),
  nickname: z.string(),
  /** 令牌受众：商户入口恒为 `merchant`（`docs/09` §9.1）。 */
  aud: z.literal("merchant"),
  /** 主角色 code。 */
  role: z.string().min(1),
  roles: z.array(z.string().min(1)),
  /** 权限点集合（`packages/shared/src/rbac.ts`），前端菜单与按钮同源渲染。 */
  permissions: z.array(z.string().min(1)),
  /** 商户身份绑定的商户 ID 列表（隔离由 `merchantScope` 后端强制）。 */
  merchantIds: z.array(UlidSchema),
});

/** `POST /merchant/login` 与 `POST /merchant/refresh` 的 `data`。 */
export const MerchantLoginResultSchema = z.object({
  accessToken: z.string().min(1),
  /** 有效期秒数（`docs/09` §9.1：Access Token 2h）。 */
  expiresIn: z.number().int().positive(),
  subject: MerchantSubjectSchema,
});

/** `POST /merchant/refresh` 请求体（旋转式刷新，`docs/09` §9.1）。 */
export const MerchantRefreshBodySchema = z.object({
  /** Refresh Token 亦可走 HttpOnly Cookie；请求体形式供小程序 / APP 预留。 */
  refreshToken: z.string().min(1).optional(),
});

/** `POST /merchant/logout` 的 `data`。 */
export const MerchantLogoutResultSchema = z.object({ loggedOut: z.boolean() });

/* -------------------------------------------------------------------------- */
/* 订单与子单（`docs/08` §8.3：主单状态 + 子单状态都要展示）                    */
/* -------------------------------------------------------------------------- */

/** 子单（独立流转）。 */
export const MerchantSubOrderSchema = z.object({
  subOrderNo: SubOrderNoSchema,
  merchantId: UlidSchema,
  merchantName: z.string().min(1),
  status: SubOrderStatusSchema,
  statusText: z.string().min(1),
  shipFrom: ShipFromSchema.nullable(),
  express: ExpressSchema.nullable(),
  items: z.array(OrderItemSchema),
});

/** 子单状态摘要（列表页直接看到子单状态，不必进详情）。 */
export const MerchantSubOrderStatusSchema = z.object({
  subOrderNo: SubOrderNoSchema,
  statusText: z.string().min(1),
});

/** 订单列表项。 */
export const MerchantOrderSummarySchema = z.object({
  orderNo: OrderNoSchema,
  status: OrderStatusSchema,
  statusText: z.string().min(1),
  channel: z.string().min(1),
  payAmount: MoneySchema,
  currency: CurrencySchema,
  createdAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
  subOrderCount: z.number().int().positive(),
  subOrderStatuses: z.array(MerchantSubOrderStatusSchema),
});

/** 订单详情（主单 + 全部子单）。 */
export const MerchantOrderDetailSchema = MerchantOrderSummarySchema.extend({
  /** 商户后台展示**脱敏**收件人（07 §7.8.2 同口径；完整地址仅履约必要环节可见）。 */
  receiver: ShopOrderReceiverSchema,
  subOrders: z.array(MerchantSubOrderSchema),
  aftersaleSummary: z.object({
    hasAftersale: z.boolean(),
    openCount: z.number().int().nonnegative(),
    refundedAmount: MoneySchema,
  }),
});

/** `GET /merchant/orders` 查询参数。 */
export const MerchantOrderListQuerySchema = PageQuerySchema.extend({
  status: OrderStatusSchema.optional(),
  /** 订单号精确查询（列表页搜索框）。 */
  orderNo: OrderNoSchema.optional(),
});

/** `GET /merchant/orders` 的 `data`。 */
export const MerchantOrderListSchema = pageResultSchema(MerchantOrderSummarySchema);

/** `GET /merchant/orders/:orderNo` 的路径参数。 */
export const MerchantOrderParamsSchema = z.object({ orderNo: OrderNoSchema });

/* -------------------------------------------------------------------------- */
/* 售后（`docs/08` §8.4）                                                      */
/* -------------------------------------------------------------------------- */

/** 售后列表项。 */
export const MerchantAftersaleSummarySchema = z.object({
  aftersaleNo: AftersaleNoSchema,
  type: AftersaleTypeSchema,
  typeText: z.string().min(1),
  status: AftersaleStatusSchema,
  statusText: z.string().min(1),
  orderNo: OrderNoSchema,
  subOrderNo: SubOrderNoSchema,
  itemTitle: z.string().min(1),
  quantity: z.number().int().positive(),
  refundAmount: MoneySchema,
  currency: CurrencySchema,
  createdAt: IsoDateTimeSchema,
  deadlineAt: IsoDateTimeSchema.nullable(),
});

/** 售后时间线节点（`aftersale_logs`，唯一来源）。 */
export const MerchantAftersaleTimelineNodeSchema = z.object({
  time: IsoDateTimeSchema,
  status: AftersaleStatusSchema,
  statusText: z.string().min(1),
  actor: z.string().min(1),
  remark: z.string().nullable(),
});

/** 售后详情。 */
export const MerchantAftersaleDetailSchema = MerchantAftersaleSummarySchema.extend({
  skuId: UlidSchema,
  reason: z.string(),
  /** 仅下发**凭证数量**，凭证 URL 不下发（07 §7.8.2 同口径）。 */
  evidenceCount: z.number().int().nonnegative(),
  returnAddress: ShopOrderReceiverSchema.nullable(),
  returnExpress: z.object({ company: z.string().min(1), no: z.string().min(1) }).nullable(),
  refund: z
    .object({
      status: z.string().min(1),
      refundNo: z.string().nullable(),
      channel: z.string().nullable(),
      arrivedAt: IsoDateTimeSchema.nullable(),
      estimatedArrivalDays: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  timeline: z.array(MerchantAftersaleTimelineNodeSchema),
});

/** `GET /merchant/aftersales` 查询参数。 */
export const MerchantAftersaleListQuerySchema = PageQuerySchema.extend({
  status: AftersaleStatusSchema.optional(),
});

/** `GET /merchant/aftersales` 的 `data`。 */
export const MerchantAftersaleListSchema = pageResultSchema(MerchantAftersaleSummarySchema);

/** `GET /merchant/aftersales/:aftersaleNo` 的路径参数。 */
export const MerchantAftersaleParamsSchema = z.object({ aftersaleNo: AftersaleNoSchema });

/* -------------------------------------------------------------------------- */
/* 商品与分类（只读）                                                          */
/* -------------------------------------------------------------------------- */

/** 商品列表项（只读展示）。 */
export const MerchantProductSummarySchema = z.object({
  spuId: UlidSchema,
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  merchantId: UlidSchema,
  categoryId: UlidSchema,
  status: z.string().min(1),
  mainImage: z.string().nullable(),
  minPrice: MoneySchema,
  maxPrice: MoneySchema,
  updatedAt: IsoDateTimeSchema,
});

/** 商品 SKU（只读，含库存）。 */
export const MerchantProductSkuSchema = z.object({
  skuId: UlidSchema,
  skuCode: z.string().min(1),
  spec: SkuSpecSchema,
  price: MoneySchema,
  /** 可售库存 = `stock - locked_stock`（05 §5.3①）。 */
  stock: z.number().int().nonnegative(),
  status: SkuStatusSchema,
});

/** `GET /merchant/products` 查询参数。 */
export const MerchantProductListQuerySchema = PageQuerySchema.extend({
  status: z.string().min(1).optional(),
  q: z.string().trim().max(64, "关键词过长").optional(),
  categoryId: UlidSchema.optional(),
});

/** `GET /merchant/products` 的 `data`。 */
export const MerchantProductListSchema = pageResultSchema(MerchantProductSummarySchema);

/** 分类列表项（`categories`，`parentId` 为 `null` 即根）。 */
export const MerchantCategorySchema = z.object({
  id: UlidSchema,
  parentId: UlidSchema.nullable(),
  name: z.string().min(1),
  /** 层级，根为 `1`。 */
  level: z.number().int().positive(),
  sortOrder: z.number().int(),
  status: z.string().min(1),
});

/** `GET /merchant/categories` 的 `data`。 */
export const MerchantCategoryListSchema = pageResultSchema(MerchantCategorySchema);

/* -------------------------------------------------------------------------- */
/* 商户与门店（只读）                                                          */
/* -------------------------------------------------------------------------- */

/** 商户（只读展示）。 */
export const MerchantSummarySchema = z.object({
  id: UlidSchema,
  name: z.string().min(1),
  type: MerchantTypeSchema,
  status: z.string().min(1),
  contactName: z.string(),
  contactPhone: z.string(),
  createdAt: IsoDateTimeSchema,
});

/** 门店 / 仓库（只读展示）。 */
export const MerchantStoreSchema = z.object({
  id: UlidSchema,
  merchantId: UlidSchema,
  name: z.string().min(1),
  type: z.string().min(1),
  city: z.string(),
  province: z.string(),
  supportsPickup: z.boolean(),
  status: z.string().min(1),
});

/** `GET /merchant/merchants` 的 `data`。 */
export const MerchantSummaryListSchema = pageResultSchema(MerchantSummarySchema);

/** `GET /merchant/stores` 的 `data`。 */
export const MerchantStoreListSchema = pageResultSchema(MerchantStoreSchema);

/* -------------------------------------------------------------------------- */
/* 端点清单（供路由注册与契约测试共用）                                        */
/* -------------------------------------------------------------------------- */

/** merchant 端点规格：方法 + 路径模板 + 请求 / 响应 Schema。 */
export interface MerchantEndpointSpec {
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
  /** 是否受 `merchantScope` 行级隔离（09 §9.2）。 */
  readonly merchantScoped: boolean;
}

/**
 * merchant 组端点全集。
 *
 * `path` 与 `apps/admin/src/api/endpoints.ts` 的 `MERCHANT_ENDPOINTS` **逐字对应**
 * （去掉 `/api/v1` 前缀）。
 */
export const MERCHANT_ENDPOINTS = {
  /** `POST /api/v1/merchant/login` —— 商户入口登录（`aud=merchant`）。 */
  LOGIN: {
    method: HTTP_METHOD.POST,
    path: "/merchant/login",
    querySchema: null,
    bodySchema: MerchantLoginBodySchema,
    responseSchema: MerchantLoginResultSchema,
    merchantScoped: false,
  },
  /** `POST /api/v1/merchant/refresh` —— 旋转式刷新（`docs/09` §9.1）。 */
  REFRESH: {
    method: HTTP_METHOD.POST,
    path: "/merchant/refresh",
    querySchema: null,
    bodySchema: MerchantRefreshBodySchema,
    responseSchema: MerchantLoginResultSchema,
    merchantScoped: false,
  },
  /** `POST /api/v1/merchant/logout`。 */
  LOGOUT: {
    method: HTTP_METHOD.POST,
    path: "/merchant/logout",
    querySchema: null,
    bodySchema: null,
    responseSchema: MerchantLogoutResultSchema,
    merchantScoped: false,
  },
  /** `GET /api/v1/merchant/me` —— 当前身份与权限点。 */
  ME: {
    method: HTTP_METHOD.GET,
    path: "/merchant/me",
    querySchema: null,
    bodySchema: null,
    responseSchema: MerchantSubjectSchema,
    merchantScoped: true,
  },
  /** `GET /api/v1/merchant/orders` —— 本商户订单列表（行级隔离）。 */
  ORDERS: {
    method: HTTP_METHOD.GET,
    path: "/merchant/orders",
    querySchema: MerchantOrderListQuerySchema,
    bodySchema: null,
    responseSchema: MerchantOrderListSchema,
    merchantScoped: true,
  },
  /** `GET /api/v1/merchant/orders/:orderNo`。 */
  ORDER_DETAIL: {
    method: HTTP_METHOD.GET,
    path: "/merchant/orders/:orderNo",
    querySchema: null,
    bodySchema: null,
    responseSchema: MerchantOrderDetailSchema,
    merchantScoped: true,
  },
  /** `GET /api/v1/merchant/aftersales` —— 本商户售后列表。 */
  AFTERSALES: {
    method: HTTP_METHOD.GET,
    path: "/merchant/aftersales",
    querySchema: MerchantAftersaleListQuerySchema,
    bodySchema: null,
    responseSchema: MerchantAftersaleListSchema,
    merchantScoped: true,
  },
  /** `GET /api/v1/merchant/aftersales/:aftersaleNo` —— 含 `aftersale_logs` 时间线。 */
  AFTERSALE_DETAIL: {
    method: HTTP_METHOD.GET,
    path: "/merchant/aftersales/:aftersaleNo",
    querySchema: null,
    bodySchema: null,
    responseSchema: MerchantAftersaleDetailSchema,
    merchantScoped: true,
  },
  /** `GET /api/v1/merchant/products` —— 本商户商品列表（只读）。 */
  PRODUCTS: {
    method: HTTP_METHOD.GET,
    path: "/merchant/products",
    querySchema: MerchantProductListQuerySchema,
    bodySchema: null,
    responseSchema: MerchantProductListSchema,
    merchantScoped: true,
  },
  /** `GET /api/v1/merchant/categories` —— 类目列表（只读）。 */
  CATEGORIES: {
    method: HTTP_METHOD.GET,
    path: "/merchant/categories",
    querySchema: null,
    bodySchema: null,
    responseSchema: MerchantCategoryListSchema,
    merchantScoped: false,
  },
  /** `GET /api/v1/merchant/merchants` —— 商户列表（只读，受隔离收敛到自身）。 */
  MERCHANTS: {
    method: HTTP_METHOD.GET,
    path: "/merchant/merchants",
    querySchema: null,
    bodySchema: null,
    responseSchema: MerchantSummaryListSchema,
    merchantScoped: true,
  },
  /** `GET /api/v1/merchant/stores` —— 门店 / 仓库列表（只读）。 */
  STORES: {
    method: HTTP_METHOD.GET,
    path: "/merchant/stores",
    querySchema: null,
    bodySchema: null,
    responseSchema: MerchantStoreListSchema,
    merchantScoped: true,
  },
} as const satisfies Record<string, MerchantEndpointSpec>;

/** merchant 组端点列表（路由注册与契约测试共用）。 */
export const MERCHANT_ENDPOINT_LIST: readonly MerchantEndpointSpec[] =
  Object.values(MERCHANT_ENDPOINTS);

/** merchant 路由前缀（`docs/06` §6：`/api/v1/merchant/...`）。 */
export const MERCHANT_ROUTE_PREFIX = "/api/v1/merchant";
