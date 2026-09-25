/**
 * Agent API 契约（契约中心，零业务逻辑）。
 *
 * 权威来源：`docs/07-Agent-API契约.md` §7.2–§7.7。
 * **响应形状逐字对齐** PiEcho 侧 `tests/contract/fixtures/*.success.json`
 * （那些 fixture 已按本文档校验通过）——本文件是 DShop 侧的唯一真相源。
 *
 * 六端点：
 * | 端点 | scope | 限流 | 缓存 |
 * | --- | --- | --- | --- |
 * | `GET /orders/{orderNo}` | `agent:order:read` | 120/min (burst 20) | 10s |
 * | `GET /orders` | `agent:order:read` | 120/min | 10s |
 * | `GET /products/{spuId}/specs` | `agent:product:read` | 300/min | 60s |
 * | `GET /products/{spuId}/stock` | `agent:product:read` | 300/min | 30s |
 * | `GET /aftersales/{aftersaleNo}` | `agent:aftersale:read` | 120/min | 10s |
 * | `GET /policies/{category}` | `agent:policy:read` | 60/min | 300s |
 */

import { z } from "zod";
import {
  AFTERSALE_ACTOR,
  AFTERSALE_STATUS,
  AFTERSALE_TYPE,
  AftersaleActorSchema,
  AftersaleStatusSchema,
  AftersaleTypeSchema,
  CurrencySchema,
  ORDER_CHANNEL,
  ORDER_STATUS,
  OrderChannelSchema,
  OrderStatusSchema,
  POLICY_QUERY_CATEGORY,
  PolicyQueryCategorySchema,
  PRODUCT_STATUS,
  ProductStatusSchema,
  SKU_STATUS,
  SkuStatusSchema,
} from "../enums.js";
import { AFTERSALE_NO_PATTERN, ORDER_NO_PATTERN, UlidSchema } from "../ids.js";
import {
  ExpressSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneySchema,
  OrderItemSchema,
  ReceiverSchema,
  ReturnAddressSchema,
  ShipFromSchema,
  SkuSpecSchema,
  StockShipFromSchema,
  CursorSchema,
} from "./common.js";

export {
  ORDER_CHANNEL,
  ORDER_STATUS,
  OrderChannelSchema,
  OrderStatusSchema,
  PRODUCT_STATUS,
  ProductStatusSchema,
  SKU_STATUS,
  SkuStatusSchema,
  AFTERSALE_STATUS,
  AFTERSALE_TYPE,
  AFTERSALE_ACTOR,
  AftersaleActorSchema,
  AftersaleStatusSchema,
  AftersaleTypeSchema,
  POLICY_QUERY_CATEGORY,
  PolicyQueryCategorySchema,
  CurrencySchema,
};

/* -------------------------------------------------------------------------- */
/* §7.2 GET /orders/{orderNo}                                                  */
/* -------------------------------------------------------------------------- */

/** 子单（含物流与商品快照）。 */
export const AgentSubOrderSchema = z.object({
  subOrderNo: z.string().min(1),
  merchantName: z.string().min(1),
  merchantType: z.string().min(1),
  status: z.enum(["PAID", "SHIPPED", "COMPLETED", "CANCELLED"]),
  statusText: z.string().min(1),
  shipFrom: ShipFromSchema,
  /** 未发货时为 `null`（07 §7.2：`express` 可为 null）。 */
  express: ExpressSchema.nullable(),
  items: z.array(OrderItemSchema).min(1),
});
export type AgentSubOrder = z.infer<typeof AgentSubOrderSchema>;

/** 售后汇总（主单维度）。 */
export const AftersaleSummarySchema = z.object({
  hasAftersale: z.boolean(),
  openCount: z.number().int().nonnegative(),
  refundedAmount: MoneySchema,
});
export type AftersaleSummary = z.infer<typeof AftersaleSummarySchema>;

/** `GET /orders/{orderNo}` 的 `data`。 */
export const AgentOrderDetailSchema = z.object({
  orderNo: z.string().regex(ORDER_NO_PATTERN),
  status: OrderStatusSchema,
  statusText: z.string().min(1),
  channel: OrderChannelSchema,
  createdAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
  payAmount: MoneySchema,
  currency: CurrencySchema,
  receiver: ReceiverSchema,
  /** 主单与子单状态**必须同时下发**（08 §8.3：客服需答「买了三件为什么只发一件」）。 */
  subOrders: z.array(AgentSubOrderSchema).min(1),
  aftersaleSummary: AftersaleSummarySchema,
});
export type AgentOrderDetail = z.infer<typeof AgentOrderDetailSchema>;

/** 路径参数：`{ orderNo }`。 */
export const AgentOrderDetailParamsSchema = z.object({
  orderNo: z.string().regex(ORDER_NO_PATTERN, "订单号格式须为 ^DS\\d{17}$"),
});
export type AgentOrderDetailParams = z.infer<typeof AgentOrderDetailParamsSchema>;

/* -------------------------------------------------------------------------- */
/* §7.3 GET /orders                                                            */
/* -------------------------------------------------------------------------- */

/** 订单列表项。 */
export const AgentOrderListItemSchema = z.object({
  orderNo: z.string().regex(ORDER_NO_PATTERN),
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
export type AgentOrderListItem = z.infer<typeof AgentOrderListItemSchema>;

/** `GET /orders` 的 `data`。 */
export const AgentOrderListSchema = z.object({
  userId: UlidSchema,
  list: z.array(AgentOrderListItemSchema),
  nextCursor: CursorSchema.nullable(),
  hasMore: z.boolean(),
});
export type AgentOrderList = z.infer<typeof AgentOrderListSchema>;

/**
 * `GET /orders` 查询参数（07 §7.3）。
 *
 * `userId` 与 `phone` **二选一**：同时缺失或同时提供 → `40001`。
 * 该校验在 `superRefine` 中实现，供 handler 复用。
 */
export const AgentOrderListQuerySchema = z
  .object({
    userId: UlidSchema.optional(),
    phone: z
      .string()
      .regex(/^1\d{10}$/, "手机号须为 11 位且以 1 开头")
      .optional(),
    /** 按主单状态过滤，多值逗号分隔。 */
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(20).default(5),
    cursor: CursorSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasUserId = value.userId !== undefined;
    const hasPhone = value.phone !== undefined;
    if (hasUserId === hasPhone) {
      ctx.addIssue({
        code: "custom",
        message: "userId 与 phone 必须二选一（不可同时缺失或同时提供）",
        path: ["userId"],
      });
    }
  });
export type AgentOrderListQuery = z.infer<typeof AgentOrderListQuerySchema>;

/** 解析 `status` 多值参数（逗号分隔）为合法状态数组；非法值抛错。 */
export function parseStatusFilter(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  const valid = new Set<string>(Object.values(ORDER_STATUS));
  for (const p of parts) {
    if (!valid.has(p)) {
      throw new Error(`status 含非法取值：${p}`);
    }
  }
  return parts;
}

/* -------------------------------------------------------------------------- */
/* §7.4 GET /products/{spuId}/specs                                            */
/* -------------------------------------------------------------------------- */

/** 参数白皮书中的单条参数。`unit` 可为 `null`。 */
export const AgentAttrSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  unit: z.string().nullable(),
});
export type AgentAttr = z.infer<typeof AgentAttrSchema>;

/** 参数分组。`groupName` 必须包含「防护等级」等边界信息组（08 §8.7 硬性要求）。 */
export const AgentAttrGroupSchema = z.object({
  groupName: z.string().min(1),
  attrs: z.array(AgentAttrSchema),
});
export type AgentAttrGroup = z.infer<typeof AgentAttrGroupSchema>;

/** 规格维度（`specDimensions`）。 */
export const AgentSpecDimensionSchema = z.object({
  name: z.string().min(1),
  values: z.array(z.string().min(1)).min(1),
});
export type AgentSpecDimension = z.infer<typeof AgentSpecDimensionSchema>;

/** 规格页的 SKU（**不含 `stock` 数值**，仅 `inStock` 布尔——库存走 `/stock` 端点）。 */
export const AgentSpecSkuSchema = z.object({
  skuId: UlidSchema,
  skuCode: z.string().min(1),
  spec: SkuSpecSchema,
  price: MoneySchema,
  marketPrice: MoneySchema,
  status: SkuStatusSchema,
  inStock: z.boolean(),
});
export type AgentSpecSku = z.infer<typeof AgentSpecSkuSchema>;

/** `GET /products/{spuId}/specs` 的 `data`。 */
export const AgentProductSpecsSchema = z.object({
  spuId: UlidSchema,
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  brand: z.string().nullable(),
  categoryPath: z.array(z.string().min(1)),
  status: ProductStatusSchema,
  mainImage: z.string().nullable(),
  updatedAt: IsoDateTimeSchema,
  /** 语料同步用内容哈希（PiEcho 按此感知变化）。 */
  contentHash: z.string().min(1),
  attrGroups: z.array(AgentAttrGroupSchema),
  specDimensions: z.array(AgentSpecDimensionSchema),
  skus: z.array(AgentSpecSkuSchema),
});
export type AgentProductSpecs = z.infer<typeof AgentProductSpecsSchema>;

export const AgentProductSpecsParamsSchema = z.object({ spuId: UlidSchema });
export type AgentProductSpecsParams = z.infer<typeof AgentProductSpecsParamsSchema>;

/* -------------------------------------------------------------------------- */
/* §7.5 GET /products/{spuId}/stock                                            */
/* -------------------------------------------------------------------------- */

/** 库存页的 SKU。`stock` 是**可售库存** = `stock - locked_stock`。 */
export const AgentStockSkuSchema = z.object({
  skuId: UlidSchema,
  skuCode: z.string().min(1),
  spec: SkuSpecSchema,
  stock: z.number().int().nonnegative(),
  inStock: z.boolean(),
  /** **SKU 级**预计到货日期（取自 `product_skus.restock_eta`），无则 `null`。 */
  restockEta: IsoDateSchema.nullable(),
});
export type AgentStockSku = z.infer<typeof AgentStockSkuSchema>;

/** `GET /products/{spuId}/stock` 的 `data`。 */
export const AgentProductStockSchema = z.object({
  spuId: UlidSchema,
  status: ProductStatusSchema,
  checkQuantity: z.number().int().positive(),
  /** 目标数量 ≤ 可售库存。客服话术应优先依据此字段。 */
  available: z.boolean(),
  totalStock: z.number().int().nonnegative(),
  updatedAt: IsoDateTimeSchema,
  shipFrom: z.array(StockShipFromSchema),
  skus: z.array(AgentStockSkuSchema),
});
export type AgentProductStock = z.infer<typeof AgentProductStockSchema>;

export const AgentProductStockParamsSchema = z.object({ spuId: UlidSchema });
export type AgentProductStockParams = z.infer<typeof AgentProductStockParamsSchema>;

export const AgentProductStockQuerySchema = z.object({
  skuId: UlidSchema.optional(),
  quantity: z.coerce.number().int().positive().default(1),
  /** 收货地区码（**预留**：多仓就近判断，一期不使用）。 */
  regionCode: z.string().optional(),
});
export type AgentProductStockQuery = z.infer<typeof AgentProductStockQuerySchema>;

/* -------------------------------------------------------------------------- */
/* §7.6 GET /aftersales/{aftersaleNo}                                          */
/* -------------------------------------------------------------------------- */

/** 售后时间线节点。**每次流转必须写 `aftersale_logs`**（timeline 的唯一来源）。 */
export const AgentAftersaleTimelineEntrySchema = z.object({
  at: IsoDateTimeSchema,
  actor: AftersaleActorSchema,
  from: AftersaleStatusSchema.nullable(),
  to: AftersaleStatusSchema,
  remark: z.string().nullable(),
});
export type AgentAftersaleTimelineEntry = z.infer<typeof AgentAftersaleTimelineEntrySchema>;

/** 退款信息。未进入退款流程时各字段为 `null`。 */
export const AgentAftersaleRefundSchema = z.object({
  status: z.string().min(1),
  refundNo: z.string().nullable(),
  channel: z.string().nullable(),
  arrivedAt: IsoDateTimeSchema.nullable(),
  estimatedArrivalDays: z.number().int().nonnegative().nullable(),
});
export type AgentAftersaleRefund = z.infer<typeof AgentAftersaleRefundSchema>;

/** 关联政策摘要。 */
export const AgentAftersalePolicySchema = z.object({
  category: z.string().min(1),
  title: z.string().min(1),
  version: z.string().min(1),
  summary: z.string().nullable(),
});
export type AgentAftersalePolicy = z.infer<typeof AgentAftersalePolicySchema>;

/** 回寄物流（买家填写后才有值）。 */
export const AgentReturnExpressSchema = z.object({
  company: z.string().min(1),
  no: z.string().min(1),
  shippedAt: IsoDateTimeSchema.nullable(),
});
export type AgentReturnExpress = z.infer<typeof AgentReturnExpressSchema>;

/** `GET /aftersales/{aftersaleNo}` 的 `data`。 */
export const AgentAftersaleDetailSchema = z.object({
  aftersaleNo: z.string().regex(AFTERSALE_NO_PATTERN),
  type: AftersaleTypeSchema,
  typeText: z.string().min(1),
  status: AftersaleStatusSchema,
  statusText: z.string().min(1),
  orderNo: z.string().regex(ORDER_NO_PATTERN),
  subOrderNo: z.string().min(1),
  skuId: UlidSchema,
  itemTitle: z.string().min(1),
  quantity: z.number().int().positive(),
  refundAmount: MoneySchema,
  currency: CurrencySchema,
  reason: z.string().nullable(),
  /** 仅下发**凭证数量**，凭证 URL **绝不下发**（07 §7.8.2）。 */
  evidenceCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  deadlineAt: IsoDateTimeSchema.nullable(),
  /** 仅 `WAIT_BUYER_RETURN` 及之后有值（脱敏后下发）。 */
  returnAddress: ReturnAddressSchema.nullable(),
  returnExpress: AgentReturnExpressSchema.nullable(),
  refund: AgentAftersaleRefundSchema,
  timeline: z.array(AgentAftersaleTimelineEntrySchema),
  policy: AgentAftersalePolicySchema.nullable(),
});
export type AgentAftersaleDetail = z.infer<typeof AgentAftersaleDetailSchema>;

export const AgentAftersaleDetailParamsSchema = z.object({
  aftersaleNo: z.string().regex(AFTERSALE_NO_PATTERN, "售后单号格式须为 ^AS\\d{11}$"),
});
export type AgentAftersaleDetailParams = z.infer<typeof AgentAftersaleDetailParamsSchema>;

/* -------------------------------------------------------------------------- */
/* §7.7 GET /policies/{category}                                               */
/* -------------------------------------------------------------------------- */

/** 政策条款项。 */
export const AgentPolicyItemSchema = z.object({
  policyId: UlidSchema,
  title: z.string().min(1),
  version: z.string().min(1),
  effectiveFrom: IsoDateTimeSchema,
  effectiveTo: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  /** markdown 正文（**逐字下发**，PiEcho 据此切片入库）。 */
  content: z.string(),
  tags: z.array(z.string()),
});
export type AgentPolicyItem = z.infer<typeof AgentPolicyItemSchema>;

/** `GET /policies/{category}` 的 `data`。 */
export const AgentPoliciesSchema = z.object({
  category: PolicyQueryCategorySchema,
  contentHash: z.string().min(1),
  items: z.array(AgentPolicyItemSchema),
});
export type AgentPolicies = z.infer<typeof AgentPoliciesSchema>;

export const AgentPoliciesParamsSchema = z.object({ category: PolicyQueryCategorySchema });
export type AgentPoliciesParams = z.infer<typeof AgentPoliciesParamsSchema>;

/* -------------------------------------------------------------------------- */
/* 端点清单（供路由注册、限流、缓存、scope 校验共用）                            */
/* -------------------------------------------------------------------------- */

export interface AgentEndpointSpec {
  /** 路由路径（Hono 语法）。 */
  readonly path: string;
  /** 所需 scope。 */
  readonly scope: string;
  /** 令牌级限流：每分钟次数。 */
  readonly rateLimitPerMin: number;
  /** 令牌桶 burst。 */
  readonly burst: number;
  /** 边缘缓存秒数。 */
  readonly cacheTtlSeconds: number;
  /** 端点级缓存 key 前缀。 */
  readonly cacheKeyPrefix: string;
}

export const AGENT_ENDPOINTS: readonly AgentEndpointSpec[] = [
  {
    path: "/orders",
    scope: "agent:order:read",
    rateLimitPerMin: 120,
    burst: 20,
    cacheTtlSeconds: 10,
    cacheKeyPrefix: "agent:orders",
  },
  {
    path: "/orders/:orderNo",
    scope: "agent:order:read",
    rateLimitPerMin: 120,
    burst: 20,
    cacheTtlSeconds: 10,
    cacheKeyPrefix: "agent:order",
  },
  {
    path: "/products/:spuId/specs",
    scope: "agent:product:read",
    rateLimitPerMin: 300,
    burst: 20,
    cacheTtlSeconds: 60,
    cacheKeyPrefix: "agent:specs",
  },
  {
    path: "/products/:spuId/stock",
    scope: "agent:product:read",
    rateLimitPerMin: 300,
    burst: 20,
    cacheTtlSeconds: 30,
    cacheKeyPrefix: "agent:stock",
  },
  {
    path: "/aftersales/:aftersaleNo",
    scope: "agent:aftersale:read",
    rateLimitPerMin: 120,
    burst: 20,
    cacheTtlSeconds: 10,
    cacheKeyPrefix: "agent:aftersale",
  },
  {
    path: "/policies/:category",
    scope: "agent:policy:read",
    rateLimitPerMin: 60,
    burst: 20,
    cacheTtlSeconds: 300,
    cacheKeyPrefix: "agent:policies",
  },
];

/** 令牌级默认配额（`service_tokens.rate_limit_per_min` 默认值，07 §7.8.4）。 */
export const DEFAULT_TOKEN_RATE_LIMIT_PER_MIN = 600;

/** Agent 路由前缀。 */
export const AGENT_ROUTE_PREFIX = "/api/v1/agent";
