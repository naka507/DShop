/**
 * 交易域（8 表）：`cart_items`、`orders`★、`sub_orders`★、`order_items`★、
 * `order_status_logs`★、`payments`、`refunds`、`idempotency_keys`。
 *
 * 列名基准：`docs/M0-字段契约.md` §5。
 * 单号规则（契约 §0 全局约定 + 简报 §3.6，正则见 `@dshop/shared` 的 `ids.ts`）：
 * - `orders.order_no`       `^DS\d{17}$`（14 位 UTC+8 `YYYYMMDDHHmmss` + 3 位当秒序列）
 * - `sub_orders.sub_order_no` `^DS\d{17}-\d{2}$`
 * - `payments.pay_no`       `^PAY\d{17}$`
 * - `refunds.refund_no`     `^RF\d{17}$`
 */

import type { OrderChannel, OrderStatus, PaymentChannel, PaymentStatus, RefundStatus, SubOrderStatus } from "@dshop/shared";
import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** `cart_items` —— 购物车。 */
export const cartItems = sqliteTable(
  "cart_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    skuId: text("sku_id").notNull(),
    quantity: integer("quantity").notNull(),
    selected: integer("selected").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_cart_items").on(t.userId, t.skuId)],
);

/** `orders` —— 主单。★ 状态**由子单聚合得出，不单独维护**。 */
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    /** `^DS\d{17}$`。 */
    orderNo: text("order_no").notNull(),
    userId: text("user_id").notNull(),
    status: text("status").$type<OrderStatus>().notNull(),
    /** 商品总额（分）。 */
    totalAmount: integer("total_amount").notNull(),
    discountAmount: integer("discount_amount").notNull().default(0),
    freightAmount: integer("freight_amount").notNull().default(0),
    payAmount: integer("pay_amount").notNull(),
    /** **JSON 原文，绝不下发**。 */
    addressSnapshot: text("address_snapshot").notNull(),
    couponId: text("coupon_id"),
    channel: text("channel").$type<OrderChannel>().notNull(),
    payDeadline: text("pay_deadline"),
    paidAt: text("paid_at"),
    completedAt: text("completed_at"),
    cancelledAt: text("cancelled_at"),
    remark: text("remark"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_orders_no").on(t.orderNo),
    index("idx_orders_user_time").on(t.userId, desc(t.createdAt)),
    index("idx_orders_status").on(t.status, desc(t.createdAt)),
  ],
);

/** `sub_orders` —— 子单。`store_id` 即契约 `shipFrom.storeId`。 */
export const subOrders = sqliteTable(
  "sub_orders",
  {
    id: text("id").primaryKey(),
    /** `^DS\d{17}-\d{2}$`。 */
    subOrderNo: text("sub_order_no").notNull(),
    orderId: text("order_id").notNull(),
    merchantId: text("merchant_id").notNull(),
    storeId: text("store_id").notNull(),
    status: text("status").$type<SubOrderStatus>().notNull(),
    subtotal: integer("subtotal").notNull(),
    /** 按 `subtotal` 比例分摊。 */
    discountAlloc: integer("discount_alloc").notNull().default(0),
    freight: integer("freight").notNull().default(0),
    commissionAmount: integer("commission_amount").notNull().default(0),
    expressCompany: text("express_company"),
    expressCompanyCode: text("express_company_code"),
    expressNo: text("express_no"),
    shippedAt: text("shipped_at"),
    receivedAt: text("received_at"),
    settled: integer("settled").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_sub_orders_no").on(t.subOrderNo),
    index("idx_sub_orders_order").on(t.orderId),
    index("idx_sub_orders_merchant").on(t.merchantId, t.status),
  ],
);

/** `order_items` —— 下单快照（标题/主图/规格/单价在支付瞬间固化，永不回查商品表）。 */
export const orderItems = sqliteTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    subOrderId: text("sub_order_id").notNull(),
    orderId: text("order_id").notNull(),
    spuId: text("spu_id").notNull(),
    skuId: text("sku_id").notNull(),
    title: text("title").notNull(),
    image: text("image"),
    spec: text("spec").notNull().default("{}"),
    unitPrice: integer("unit_price").notNull(),
    quantity: integer("quantity").notNull(),
    subtotal: integer("subtotal").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_order_items_sub").on(t.subOrderId),
    index("idx_order_items_sku").on(t.skuId),
  ],
);

/** `order_status_logs` —— 状态时间线与物流轨迹的统一落库处。★ */
export const orderStatusLogs = sqliteTable(
  "order_status_logs",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    /** 轨迹行必填。 */
    subOrderId: text("sub_order_id"),
    /** `status` = 状态流转，`trace` = 物流轨迹。 */
    kind: text("kind").notNull().default("status"),
    /** `status` 行使用。 */
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    /** `system`/`user`/`admin`/`merchant`。 */
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    /** `trace` 行的 `desc`。 */
    remark: text("remark"),
    /** `trace` 行的 `time`。 */
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_order_status_logs_order").on(t.orderId, t.createdAt),
    index("idx_order_status_logs_sub").on(t.subOrderId, t.occurredAt),
  ],
);

/** `payments` —— 支付流水。`channel_trade_no` 唯一约束是支付回调幂等锚点。 */
export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    /** `^PAY\d{17}$`。 */
    payNo: text("pay_no").notNull(),
    orderId: text("order_id").notNull(),
    channel: text("channel").$type<PaymentChannel>().notNull(),
    channelTradeNo: text("channel_trade_no").notNull(),
    amount: integer("amount").notNull(),
    /** ⚠️ 文档未定义取值，见 `enums.ts` `PAYMENT_STATUS`。 */
    status: text("status").$type<PaymentStatus>().notNull(),
    paidAt: text("paid_at"),
    /** **绝不下发**。 */
    rawCallback: text("raw_callback"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_payments_no").on(t.payNo),
    uniqueIndex("uq_payments_trade_no").on(t.channelTradeNo),
  ],
);

/** `refunds` —— 退款流水。 */
export const refunds = sqliteTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    /** `^RF\d{17}$`。 */
    refundNo: text("refund_no").notNull(),
    aftersaleId: text("aftersale_id"),
    orderId: text("order_id").notNull(),
    amount: integer("amount").notNull(),
    channel: text("channel"),
    /** ⚠️ 文档未定义取值，见 `enums.ts` `REFUND_STATUS`。 */
    status: text("status").$type<RefundStatus>().notNull(),
    channelRefundNo: text("channel_refund_no"),
    arrivedAt: text("arrived_at"),
    estimatedArrivalDays: integer("estimated_arrival_days"),
    rawCallback: text("raw_callback"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_refunds_no").on(t.refundNo),
    index("idx_refunds_aftersale").on(t.aftersaleId),
  ],
);

/** `idempotency_keys` —— 下单/支付回调幂等（`scope` + `key` 唯一）。 */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash"),
    responseBody: text("response_body"),
    status: text("status").notNull().default("processing"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_idempotency_keys").on(t.scope, t.key)],
);
