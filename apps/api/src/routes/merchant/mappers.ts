/**
 * merchant 组的行 → 契约载荷映射（纯函数，无 I/O）。
 *
 * 输出形状严格对齐 `packages/shared/src/contracts/merchant.ts` 的
 * `Merchant*Schema`；分层意图与 `routes/agent/mappers.ts` 一致：
 * 仓储取数 → 本文件组装 → 路由封装信封。
 *
 * ⚠️ 两处**契约与文档的张力**（已在汇报中登记）：
 * 1. `MerchantOrderDetailSchema.receiver` 用的是 `ShopOrderReceiverSchema`
 *    （C 端**未脱敏**六字段：`name/phone/province/city/district/detail`），
 *    而该字段的注释写「展示**脱敏**收件人（07 §7.8.2 同口径）」。
 *    实现以** Schema 为准**（它才是可校验的权威形状），直接下发快照字段——
 *    商户发货本就是「履约必要环节」。缺字段兜底为 `***`（`min(1)` 约束）。
 * 2. `MerchantAftersaleDetailSchema.reason` 是 `z.string()`（非 nullable），
 *    库内 `aftersales.reason` 可空 → 兜底空串。
 */

import {
  AFTERSALE_STATUS_TEXT,
  AFTERSALE_TYPE_TEXT,
  CURRENCY,
  OPEN_AFTERSALE_STATUSES,
  ORDER_STATUS_TEXT,
  REFUND_STATUS,
  SUB_ORDER_STATUS_TEXT,
} from "@dshop/shared";
import type {
  AftersaleStatus,
  Express,
  OrderChannel,
  OrderStatus,
  SkuSpec,
  SubOrderStatus,
} from "@dshop/shared";

import { parseJsonObject, parseSkuSpec, pickString } from "../../repositories/json.js";
import type {
  MerchantOrderDetailAggregate,
  MerchantOrderItemRow,
  MerchantOrderListRow,
  MerchantSubOrderRow,
  MerchantTraceRow,
} from "../../repositories/merchant-orders.js";
import type {
  MerchantAftersaleAggregate,
  MerchantAftersaleDetailRow,
  MerchantAftersaleListRow,
} from "../../repositories/merchant-aftersales.js";
import type {
  MerchantCategoryRow,
  MerchantMerchantRow,
  MerchantProductRow,
  MerchantStoreRow,
} from "../../repositories/merchant-catalog.js";

/* -------------------------------------------------------------------------- */
/* 兜底常量                                                                     */
/* -------------------------------------------------------------------------- */

/** 非空字符串兜底（契约多处要求 `min(1)`）。 */
const FALLBACK_TEXT = "未知";
/** 轨迹兜底文案。 */
const TRACE_FALLBACK_DESC = "物流信息更新";
/** 物流轨迹最多下发条数（与 `ExpressSchema.traces.max(10)` 一致）。 */
const EXPRESS_TRACE_LIMIT = 10;

/** 非空字符串：`null` / 空串 / 全空白 → 兜底值。 */
function nonEmpty(raw: string | null | undefined, fallback = FALLBACK_TEXT): string {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/* -------------------------------------------------------------------------- */
/* 收件人（`ShopOrderReceiverSchema`，C 端未脱敏六字段）                        */
/* -------------------------------------------------------------------------- */

/**
 * 未脱敏收件人（与 `ShopOrderReceiverSchema` 六字段逐字对应）。
 *
 * `packages/shared` 只导出该 Schema 而**未导出其推断类型**，
 * 故此处显式声明同名形状；字段漂移由 `tsc` 的响应体赋值处捕获。
 */
export interface ShopReceiver {
  readonly name: string;
  readonly phone: string;
  readonly province: string;
  readonly city: string;
  readonly district: string;
  readonly detail: string;
}

/**
 * `orders.address_snapshot` → 未脱敏收件人。
 *
 * 快照键名见 `data/seed-cs/seed_cs.sql`：
 * `receiver_name / receiver_phone / province / city / district / detail`。
 * 任何缺失字段兜底 `***`，保证满足 `min(1)`。
 *
 * ⚠️ 契约口径：`MerchantOrderDetailSchema.receiver` 用的是
 * `ShopOrderReceiverSchema`（六字段、**未脱敏**），故本函数按该形状返回；
 * `Receiver`（Agent 侧脱敏形状）不适用于 merchant 组。
 */
export function receiverFromSnapshot(snapshot: string | null | undefined): ShopReceiver {
  const obj = parseJsonObject(snapshot);
  return {
    name: nonEmpty(pickString(obj, "receiver_name"), "***"),
    phone: nonEmpty(pickString(obj, "receiver_phone"), "***"),
    province: nonEmpty(pickString(obj, "province"), "***"),
    city: nonEmpty(pickString(obj, "city"), "***"),
    district: nonEmpty(pickString(obj, "district"), "***"),
    detail: nonEmpty(pickString(obj, "detail"), "***"),
  };
}

/* -------------------------------------------------------------------------- */
/* 订单                                                                        */
/* -------------------------------------------------------------------------- */

/** 商品快照行 → `OrderItemSchema`。 */
function mapItem(item: MerchantOrderItemRow) {
  return {
    skuId: item.sku_id,
    title: nonEmpty(item.title),
    spec: parseSkuSpec(item.spec) as SkuSpec,
    unitPrice: item.unit_price,
    quantity: item.quantity,
    subtotal: item.subtotal,
  };
}

/** 子单物流 → `ExpressSchema`；无运单号时 `null`（未发货）。 */
function mapExpress(
  subOrder: MerchantSubOrderRow,
  traces: readonly MerchantTraceRow[],
): Express | null {
  const expressNo = subOrder.express_no;
  if (expressNo === null || expressNo.trim().length === 0) return null;

  const lastTrace = traces[traces.length - 1];
  const latestRemark = lastTrace?.remark ?? null;

  return {
    company: nonEmpty(subOrder.express_company, "未知快递"),
    companyCode: nonEmpty(subOrder.express_company_code, "UNKNOWN"),
    no: expressNo,
    shippedAt: subOrder.shipped_at,
    latestStatus:
      latestRemark !== null && latestRemark.trim().length > 0
        ? latestRemark
        : SUB_ORDER_STATUS_TEXT[subOrder.status],
    latestStatusAt: lastTrace?.occurred_at ?? subOrder.shipped_at,
    traces: traces.map((trace) => ({
      time: trace.occurred_at,
      desc: nonEmpty(trace.remark, TRACE_FALLBACK_DESC),
    })),
  };
}

/** 售后汇总（`aftersaleSummary`，与 Agent 组同口径）。 */
export function mapAftersaleSummary(
  aftersales: readonly { readonly status: string; readonly refund_amount: number }[],
): { hasAftersale: boolean; openCount: number; refundedAmount: number } {
  const open = new Set<string>(OPEN_AFTERSALE_STATUSES);
  let openCount = 0;
  let refundedAmount = 0;
  for (const row of aftersales) {
    if (open.has(row.status)) openCount += 1;
    if (row.status === "REFUNDED") refundedAmount += row.refund_amount;
  }
  return { hasAftersale: aftersales.length > 0, openCount, refundedAmount };
}

/**
 * 列表项 → `MerchantOrderSummarySchema`。
 *
 * 主单状态**由子单聚合**（`docs/08` §8.3）；`subOrderCount` 契约要求**正整数**——
 * 可见性判据已保证至少有 1 个可见子单（见 `merchant-orders.ts` 的 `EXISTS`）。
 */
export function mapOrderSummary(row: MerchantOrderListRow): {
  orderNo: string;
  status: OrderStatus;
  statusText: string;
  channel: string;
  payAmount: number;
  currency: typeof CURRENCY;
  createdAt: string;
  paidAt: string | null;
  subOrderCount: number;
  subOrderStatuses: { subOrderNo: string; statusText: string }[];
} {
  const status = aggregateStatus(row.subOrders.map((sub) => sub.status));
  return {
    orderNo: row.order.order_no,
    status,
    statusText: ORDER_STATUS_TEXT[status],
    channel: row.order.channel,
    payAmount: row.order.pay_amount,
    currency: CURRENCY,
    createdAt: row.order.created_at,
    paidAt: row.order.paid_at,
    subOrderCount: Math.max(row.subOrders.length, 1),
    subOrderStatuses: row.subOrders.map((sub) => ({
      subOrderNo: sub.sub_order_no,
      statusText: SUB_ORDER_STATUS_TEXT[sub.status],
    })),
  };
}

/** 详情聚合体 → `MerchantOrderDetailSchema`。 */
export function mapOrderDetail(aggregate: MerchantOrderDetailAggregate) {
  const summary = mapOrderSummary({
    order: aggregate.order,
    subOrders: aggregate.subOrders,
    items: aggregate.items,
    aftersales: aggregate.aftersales,
  });

  const storeById = new Map(aggregate.stores.map((store) => [store.id, store]));

  return {
    ...summary,
    receiver: receiverFromSnapshot(aggregate.order.address_snapshot),
    subOrders: aggregate.subOrders.map((sub) => {
      const store = storeById.get(sub.store_id) ?? null;
      return {
        subOrderNo: sub.sub_order_no,
        merchantId: sub.merchant_id,
        merchantName: nonEmpty(store?.name),
        status: sub.status,
        statusText: SUB_ORDER_STATUS_TEXT[sub.status],
        shipFrom:
          store === null
            ? null
            : {
                storeName: nonEmpty(store.name),
                city: nonEmpty(store.city ?? store.province),
              },
        express: mapExpress(
          sub,
          aggregate.traces
            .filter((trace) => trace.sub_order_id === sub.id)
            .slice(-EXPRESS_TRACE_LIMIT),
        ),
        items: aggregate.items.filter((item) => item.sub_order_id === sub.id).map(mapItem),
      };
    }),
    aftersaleSummary: mapAftersaleSummary(aggregate.aftersales),
  };
}

/** 主单状态聚合（与 `@dshop/services` 的 `aggregateOrderStatus` 同语义，此处避免循环依赖）。 */
function aggregateStatus(statuses: readonly SubOrderStatus[]): OrderStatus {
  if (statuses.length === 0) return "PENDING_PAYMENT";
  const active = statuses.filter((status) => status !== "CANCELLED");
  if (active.length === 0) return "CANCELLED";
  if (active.every((status) => status === "COMPLETED")) return "COMPLETED";
  const allShipped = active.every((s) => s === "SHIPPED" || s === "COMPLETED");
  if (allShipped && active.some((status) => status === "SHIPPED")) return "SHIPPED";
  return "PAID";
}

/** 订单渠道 → 契约枚举（`orders.channel` 与 `OrderChannelSchema` 同值域）。 */
export function orderChannelOf(raw: string): OrderChannel {
  return raw as OrderChannel;
}

/* -------------------------------------------------------------------------- */
/* 售后                                                                        */
/* -------------------------------------------------------------------------- */

/** 列表行 → `MerchantAftersaleSummarySchema`。 */
export function mapAftersaleSummaryItem(row: MerchantAftersaleListRow) {
  return {
    aftersaleNo: row.aftersale_no,
    type: row.type,
    typeText: AFTERSALE_TYPE_TEXT[row.type],
    status: row.status,
    statusText: AFTERSALE_STATUS_TEXT[row.status],
    orderNo: row.order_no,
    subOrderNo: row.sub_order_no,
    itemTitle: nonEmpty(row.item_title),
    quantity: row.quantity,
    refundAmount: row.refund_amount,
    currency: CURRENCY,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
  };
}

/** 退款信息：无 `refunds` 行时按售后状态推导（与 Agent 组同口径）。 */
function mapRefund(aggregate: MerchantAftersaleAggregate) {
  const refund = aggregate.refund;
  if (refund !== null) {
    return {
      status: refund.status,
      refundNo: refund.refund_no,
      channel: refund.channel,
      arrivedAt: refund.arrived_at,
      estimatedArrivalDays: refund.estimated_arrival_days,
    };
  }
  return {
    status:
      aggregate.aftersale.status === "REFUNDED" ? REFUND_STATUS.SUCCESS : REFUND_STATUS.PENDING,
    refundNo: null,
    channel: null,
    arrivedAt: null,
    estimatedArrivalDays: null,
  };
}

/**
 * 详情聚合体 → `MerchantAftersaleDetailSchema`。
 *
 * `timeline` 的唯一来源是 `aftersale_logs`（`docs/08` §8.4）；
 * 凭证只出**数量**（`evidenceCount`），URL 原文不出仓储层。
 */
export function mapAftersaleDetail(aggregate: MerchantAftersaleAggregate) {
  const row: MerchantAftersaleDetailRow = aggregate.aftersale;
  return {
    ...mapAftersaleSummaryItem(row),
    skuId: row.sku_id,
    reason: row.reason ?? "",
    evidenceCount: aggregate.evidenceCount,
    returnAddress: row.return_address === null ? null : receiverFromSnapshot(row.return_address),
    returnExpress:
      row.return_express_no !== null && row.return_express_no.trim().length > 0
        ? { company: nonEmpty(row.return_express_company, "未知快递"), no: row.return_express_no }
        : null,
    refund: mapRefund(aggregate),
    timeline: aggregate.logs.map((log) => ({
      time: log.occurred_at,
      status: log.to_status as AftersaleStatus,
      statusText: AFTERSALE_STATUS_TEXT[log.to_status],
      actor: log.actor_type,
      remark: log.remark,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* 商品 / 类目 / 商户 / 门店                                                    */
/* -------------------------------------------------------------------------- */

/** `products` 行 → `MerchantProductSummarySchema`。 */
export function mapProduct(row: MerchantProductRow) {
  return {
    spuId: row.id,
    title: nonEmpty(row.title),
    subtitle: row.subtitle,
    merchantId: row.merchant_id,
    categoryId: row.category_id,
    status: nonEmpty(row.status),
    mainImage: row.main_image,
    minPrice: row.min_price,
    maxPrice: row.max_price,
    updatedAt: row.updated_at,
  };
}

/** `categories` 行 → `MerchantCategorySchema`。 */
export function mapCategory(row: MerchantCategoryRow & { readonly level: number }) {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: nonEmpty(row.name),
    level: row.level,
    sortOrder: row.sort_order,
    status: nonEmpty(row.status),
  };
}

/** `merchants` 行 → `MerchantSummarySchema`（`contact_*` 可空，兜底空串）。 */
export function mapMerchant(row: MerchantMerchantRow) {
  return {
    id: row.id,
    name: nonEmpty(row.name),
    type: row.type,
    status: nonEmpty(row.status),
    contactName: row.contact_name ?? "",
    contactPhone: row.contact_phone ?? "",
    createdAt: row.created_at,
  };
}

/** `stores` 行 → `MerchantStoreSchema`（`city` / `province` 可空，兜底空串）。 */
export function mapStore(row: MerchantStoreRow) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: nonEmpty(row.name),
    type: nonEmpty(row.type),
    city: row.city ?? "",
    province: row.province ?? "",
    supportsPickup: row.supports_pickup === 1,
    status: nonEmpty(row.status),
  };
}
