/**
 * C 端视图模型（`docs/03-工程结构与前端.md` §3.5.1）。
 *
 * ## 为什么 C 端不复用 `AgentOrderDetail` 等 Agent 契约类型
 *
 * Agent 契约（`docs/07-Agent-API契约.md` §7.2）里的 `receiver` / `returnAddress`
 * 是**脱敏后**的形态（`MaskedName` / `MaskedPhone` / `MaskedAddress`，§7.8.2）。
 * C 端是**数据归属方本人**，需要展示完整收件信息，因此订单类视图模型必须单独定义；
 * 共用 Agent 类型会强加脱敏约束（`docs/01` §1.4 P3「脱敏在源头」只针对 Agent 面）。
 *
 * **枚举与文案一律复用 `@dshop/shared`**（`ORDER_STATUS_TEXT` / `SUB_ORDER_STATUS_TEXT` /
 * `AFTERSALE_STATUS_TEXT` / `ORDER_NO_PATTERN` 等），避免前后端文案漂移。
 *
 * ## 与 `@dshop/api-client` 的关系
 *
 * 本文件的类型描述**统一响应体 `data` 的形状**，供 `src/api/client.ts` 使用；
 * 具体请求实现由 `@dshop/api-client` + `src/api/transport.ts` 承担。
 */

import type { Express, OrderItem, ShipFrom } from "@dshop/shared";
import type {
  AftersaleStatus,
  AftersaleType,
  OrderChannel,
  OrderStatus,
  SubOrderStatus,
} from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 商品                                                                        */
/* -------------------------------------------------------------------------- */

/** 商品属性（`product_attrs` 的分组形态；与 Agent `/specs` 同源同 Schema）。 */
export interface ProductAttr {
  readonly name: string;
  readonly value: string;
}

/** 属性分组。 */
export interface ProductAttrGroup {
  readonly name: string;
  readonly attrs: readonly ProductAttr[];
}

/** SKU 视图。 */
export interface ProductSkuView {
  readonly skuId: string;
  readonly skuCode: string;
  readonly spec: Readonly<Record<string, string>>;
  readonly price: number;
  readonly stock: number;
  readonly status: string;
}

/** 列表项（首页 / 分类 / 搜索共用）。 */
export interface ProductSummary {
  readonly spuId: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly brand: string | null;
  readonly mainImage: string | null;
  readonly price: number;
  readonly currency: string;
  readonly status: string;
}

/** 详情页。 */
export interface ProductDetail extends ProductSummary {
  readonly description: string | null;
  readonly attrGroups: readonly ProductAttrGroup[];
  readonly skus: readonly ProductSkuView[];
}

/** 分类节点（`categories` 树）。 */
export interface CategoryNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly children: readonly CategoryNode[];
}

/* -------------------------------------------------------------------------- */
/* 购物车与结算                                                                */
/* -------------------------------------------------------------------------- */

/** 购物车行。 */
export interface CartItemView {
  readonly id: string;
  readonly skuId: string;
  readonly spuId: string;
  readonly title: string;
  readonly spec: Readonly<Record<string, string>>;
  readonly unitPrice: number;
  readonly quantity: number;
  readonly subtotal: number;
  /** 是否仍可购买（下架 / 售罄时为 `false`，结算前必须剔除）。 */
  readonly available: boolean;
}

/** 购物车聚合。 */
export interface CartView {
  readonly items: readonly CartItemView[];
  readonly totalAmount: number;
  readonly currency: string;
}

/** 收货地址簿条目（`user_addresses`）。 */
export interface AddressView {
  readonly id: string;
  readonly receiverName: string;
  readonly receiverPhone: string;
  readonly province: string;
  readonly city: string;
  readonly district: string;
  readonly detail: string;
  readonly isDefault: boolean;
}

/** 结算页试算结果（按 `merchant_id` 分商户展示，`docs/03` §3.5.1）。 */
export interface CheckoutPreview {
  readonly groups: readonly CheckoutGroup[];
  readonly goodsAmount: number;
  readonly freightAmount: number;
  readonly discountAmount: number;
  readonly payAmount: number;
  readonly currency: string;
}

/** 结算页的单个商户分组。 */
export interface CheckoutGroup {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly items: readonly CartItemView[];
  readonly goodsAmount: number;
  readonly freightAmount: number;
}

/* -------------------------------------------------------------------------- */
/* 订单（主单 + 子单，两者都必须展示 —— `docs/08` §8.3）                        */
/* -------------------------------------------------------------------------- */

/** 子单。 */
export interface OrderSubOrderView {
  readonly subOrderNo: string;
  readonly merchantName: string;
  readonly merchantType: string;
  readonly status: SubOrderStatus;
  /** 后端下发的文案；缺失时前端用 `SUB_ORDER_STATUS_TEXT` 兜底。 */
  readonly statusText: string;
  readonly shipFrom: ShipFrom;
  readonly express: Express | null;
  readonly items: readonly OrderItem[];
}

/** 主单详情。 */
export interface OrderDetailView {
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly statusText: string;
  readonly channel: OrderChannel;
  readonly createdAt: string;
  readonly paidAt: string | null;
  readonly payAmount: number;
  readonly currency: string;
  /** C 端为**未脱敏**收件人（与 Agent 面不同，见文件头）。 */
  readonly receiver: OrderReceiver;
  readonly subOrders: readonly OrderSubOrderView[];
  readonly aftersaleSummary: OrderAftersaleSummary;
}

/** 未脱敏收件人。 */
export interface OrderReceiver {
  readonly name: string;
  readonly phone: string;
  readonly province: string;
  readonly city: string;
  readonly district: string;
  readonly detail: string;
}

/** 主单维度售后汇总。 */
export interface OrderAftersaleSummary {
  readonly hasAftersale: boolean;
  readonly openCount: number;
  readonly refundedAmount: number;
}

/** 订单列表项。 */
export interface OrderListItemView {
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly statusText: string;
  readonly payAmount: number;
  readonly itemSummary: string;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly subOrderCount: number;
  readonly allShipped: boolean;
  readonly hasOpenAftersale: boolean;
}

/* -------------------------------------------------------------------------- */
/* 售后                                                                        */
/* -------------------------------------------------------------------------- */

/** 售后时间线节点（`aftersale_logs` 的展示形态）。 */
export interface AftersaleTimelineEntryView {
  readonly at: string;
  readonly actor: string;
  readonly from: AftersaleStatus | null;
  readonly to: AftersaleStatus;
  readonly remark: string | null;
}

/** 退款信息。 */
export interface AftersaleRefundView {
  readonly status: string;
  readonly refundNo: string | null;
  readonly channel: string | null;
  readonly arrivedAt: string | null;
  readonly estimatedArrivalDays: number | null;
}

/** 售后详情（C 端，含完整回寄地址）。 */
export interface AftersaleDetailView {
  readonly aftersaleNo: string;
  readonly type: AftersaleType;
  readonly typeText: string;
  readonly status: AftersaleStatus;
  readonly statusText: string;
  readonly orderNo: string;
  readonly subOrderNo: string;
  readonly skuId: string;
  readonly itemTitle: string;
  readonly quantity: number;
  readonly refundAmount: number;
  readonly currency: string;
  readonly reason: string | null;
  readonly evidenceCount: number;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
  readonly returnAddress: OrderReceiver | null;
  readonly returnExpress: {
    readonly company: string;
    readonly no: string;
    readonly shippedAt: string | null;
  } | null;
  readonly refund: AftersaleRefundView;
  readonly timeline: readonly AftersaleTimelineEntryView[];
}

/** 售后列表项。 */
export interface AftersaleListItemView {
  readonly aftersaleNo: string;
  readonly orderNo: string;
  readonly type: AftersaleType;
  readonly typeText: string;
  readonly status: AftersaleStatus;
  readonly statusText: string;
  readonly itemTitle: string;
  readonly refundAmount: number;
  readonly createdAt: string;
}

/** 提交售后申请的请求体（`POST /api/v1/shop/aftersales`）。 */
export interface AftersaleApplyInput {
  readonly orderNo: string;
  readonly subOrderNo: string;
  readonly skuId: string;
  readonly quantity: number;
  readonly type: AftersaleType;
  readonly reason: string;
  /** 凭证对象键（预签名直传 R2 后的 key，`docs/03` §3.5.1）。 */
  readonly evidenceKeys?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* 认证                                                                        */
/* -------------------------------------------------------------------------- */

/** 登录态用户（`aud=shop`，`docs/09` §9.1）。 */
export interface ShopUser {
  readonly userId: string;
  readonly nickname: string | null;
  readonly phoneMasked: string;
}
