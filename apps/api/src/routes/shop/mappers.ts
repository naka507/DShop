/**
 * C 端契约的行 → 载荷映射（纯函数，无 I/O）。
 *
 * 输出形状严格对齐 `packages/shared/src/contracts/shop.ts` 的 `Shop*Schema`。
 *
 * ## 与 Agent 面 `mappers.ts` 的关键差异（`contracts/shop.ts` 文件头）
 *
 * C 端是**数据归属方本人**，故 `receiver` / `returnAddress` **不脱敏**，
 * 完整下发姓名 / 手机号 / 详细地址。脱敏约束只针对 Agent 面（`docs/07` §7.8.2）。
 *
 * ## 仍然不下发的字段
 *
 * - `orders.address_snapshot` **原文**（JSON 串本身不下发，只下发解析出的字段）
 * - `aftersales.evidence_urls` → 只出 `evidenceCount`
 */

import {
  AFTERSALE_STATUS,
  AFTERSALE_STATUS_TEXT,
  AFTERSALE_TYPE_TEXT,
  CURRENCY,
  OPEN_AFTERSALE_STATUSES,
  ORDER_STATUS_TEXT,
  type ShopAddressSchema,
  type ShopAftersaleDetailSchema,
  type ShopAftersaleListItemSchema,
  type ShopCartItemSchema,
  type ShopCartSchema,
  type ShopCheckoutPreviewSchema,
  type ShopOrderDetailSchema,
  type ShopOrderListItemSchema,
  type ShopOrderReceiverSchema,
  type ShopSubOrderSchema,
  SUB_ORDER_STATUS,
  SUB_ORDER_STATUS_TEXT,
} from "@dshop/shared";
import type {
  AftersaleStatus,
  AftersaleType,
  OrderStatus,
  ShopCategoryNode,
  SkuSpec,
  SubOrderStatus,
} from "@dshop/shared";
import { aggregateOrderStatus, availableStock } from "@dshop/services";
import type { z } from "zod";

import {
  parseJsonObject,
  parseSkuSpec,
  parseStringArray,
  pickString,
} from "../../repositories/json.js";
import type { ShopCartRow } from "../../repositories/shop-cart.js";
import type {
  ShopCategoryRow,
  ShopProductDetailAggregate,
  ShopProductListRow,
} from "../../repositories/shop-catalog.js";
import type {
  ShopAftersaleDetailAggregate,
  ShopAftersaleListRow,
} from "../../repositories/shop-aftersales.js";
import type {
  ShopOrderDetailAggregate,
  ShopOrderItemRow,
  ShopOrderListAggregate,
  ShopSubOrderRow,
} from "../../repositories/shop-orders.js";

/*
 * ⚠️ `contracts/shop.ts` 只导出 Schema 与 `ShopCategoryNode` 接口，
 * **未导出**各响应的 `z.infer` 别名。为不改动 `packages/**`（文件所有权约束），
 * 这里用 `z.infer<typeof Schema>` 就地派生，效果与共享包导出别名等价。
 */
type ShopAddress = z.infer<typeof ShopAddressSchema>;
type ShopAftersaleDetail = z.infer<typeof ShopAftersaleDetailSchema>;
type ShopAftersaleListItem = z.infer<typeof ShopAftersaleListItemSchema>;
type ShopCart = z.infer<typeof ShopCartSchema>;
type ShopCartItem = z.infer<typeof ShopCartItemSchema>;
type ShopCheckoutPreview = z.infer<typeof ShopCheckoutPreviewSchema>;
type ShopOrderDetail = z.infer<typeof ShopOrderDetailSchema>;
type ShopOrderListItem = z.infer<typeof ShopOrderListItemSchema>;
type ShopOrderReceiver = z.infer<typeof ShopOrderReceiverSchema>;
type ShopSubOrder = z.infer<typeof ShopSubOrderSchema>;

/* -------------------------------------------------------------------------- */
/* 分类树                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 扁平行 → 树（`ShopCategoryNodeSchema` 自引用）。
 *
 * ⚠️ 孤儿节点（`parent_id` 指向不存在的行）按**根节点**处理，避免整棵树丢数据。
 * 同时用 `visited` 集合防御脏数据造成的环（否则会无限递归）。
 */
export function buildCategoryTree(rows: readonly ShopCategoryRow[]): ShopCategoryNode[] {
  const childrenByParent = new Map<string | null, ShopCategoryRow[]>();
  const knownIds = new Set(rows.map((r) => r.id));

  for (const row of rows) {
    const parent = row.parent_id !== null && knownIds.has(row.parent_id) ? row.parent_id : null;
    const list = childrenByParent.get(parent);
    if (list === undefined) childrenByParent.set(parent, [row]);
    else list.push(row);
  }

  const visited = new Set<string>();

  const build = (parentId: string | null): ShopCategoryNode[] =>
    (childrenByParent.get(parentId) ?? [])
      .filter((row) => !visited.has(row.id))
      .map((row) => {
        visited.add(row.id);
        return {
          id: row.id,
          name: row.name,
          parentId,
          children: build(row.id),
        };
      });

  return build(null);
}

/* -------------------------------------------------------------------------- */
/* 商品                                                                        */
/* -------------------------------------------------------------------------- */

/** 商品列表行 → `ShopProductSummarySchema`。 */
export function mapProductSummary(row: ShopProductListRow) {
  return {
    spuId: row.id,
    title: row.title,
    subtitle: row.subtitle,
    brand: row.brand,
    mainImage: row.main_image,
    // 无在售 SKU 时起售价兜底为 0（契约要求非负整数）
    price: row.min_price ?? 0,
    currency: CURRENCY,
    status: row.status,
  };
}

/**
 * 商品详情聚合体 → `ShopProductDetailSchema`。
 *
 * ⚠️ `stock` 是**可售库存** = `stock - locked_stock`（`docs/05` §5.3①），
 * 与 Agent `/stock` 同一口径——口径不一致会导致「页面显示有货但下不了单」。
 */
export function mapProductDetail(aggregate: ShopProductDetailAggregate) {
  const { product, attrs, skus } = aggregate;

  const groups = new Map<string, { name: string; value: string }[]>();
  for (const attr of attrs) {
    const list = groups.get(attr.group_name);
    const entry = { name: attr.attr_name, value: attr.attr_value };
    if (list === undefined) groups.set(attr.group_name, [entry]);
    else list.push(entry);
  }

  const firstPrice = skus.length > 0 ? Math.min(...skus.map((s) => s.price)) : 0;

  return {
    spuId: product.id,
    title: product.title,
    subtitle: product.subtitle,
    brand: product.brand,
    mainImage: product.main_image,
    price: firstPrice,
    currency: CURRENCY,
    status: product.status,
    description: product.detail_html,
    attrGroups: [...groups.entries()].map(([name, groupAttrs]) => ({
      name,
      attrs: groupAttrs,
    })),
    skus: skus.map((sku) => ({
      skuId: sku.id,
      skuCode: sku.sku_code,
      spec: parseSkuSpec(sku.spec) as SkuSpec,
      price: sku.price,
      stock: availableStock({ stock: sku.stock, lockedStock: sku.locked_stock }),
      status: sku.status,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* 购物车与结算                                                                */
/* -------------------------------------------------------------------------- */

/** 该购物车行是否仍可购买（`ShopCartItemSchema.available`）。 */
export function cartRowAvailable(row: ShopCartRow): boolean {
  if (row.sku_status !== "active" || row.product_status !== "onsale") return false;
  if (row.stock === null || row.locked_stock === null) return false;
  return availableStock({ stock: row.stock, lockedStock: row.locked_stock }) >= row.quantity;
}

/**
 * 购物车行 → `ShopCartItemSchema`。
 *
 * ⚠️ 关联缺失（SKU / 商品被物理删除）时，`title` 用占位值兜底，
 * 保持 `min(1)` 契约——**该行仍下发并标记 `available = false`**，
 * 让用户看到并手动删除，而不是静默消失。
 */
export function mapCartItem(row: ShopCartRow): ShopCartItem {
  const unitPrice = row.price ?? 0;
  return {
    id: row.id,
    skuId: row.sku_id,
    spuId: row.product_id ?? row.sku_id,
    title: row.title ?? "商品已下架",
    spec: parseSkuSpec(row.spec) as SkuSpec,
    unitPrice,
    quantity: row.quantity,
    subtotal: unitPrice * row.quantity,
    available: cartRowAvailable(row),
  };
}

/** 购物车行集合 → `ShopCartSchema`。 */
export function mapCart(rows: readonly ShopCartRow[]): ShopCart {
  const items = rows.map(mapCartItem);
  return {
    items,
    totalAmount: items.reduce((sum, item) => sum + item.subtotal, 0),
    currency: CURRENCY,
  };
}

/**
 * 购物车行集合 → `ShopCheckoutPreviewSchema`（按 `merchant_id` 分组）。
 *
 * ⚠️ **运费与优惠的缺口（如实登记）**：`freight_templates.rules` 与
 * `user_coupons` 的抵扣算法在 `docs/08` 未给出可实现的规则
 * （`freight_templates.rules` 是自由 JSON，无 Schema）。故本实现：
 * `freightAmount` / `discountAmount` 恒为 `0`，`payAmount = goodsAmount`。
 * 这是**占位值**，不是业务规则；真实计算属后续里程碑。
 */
export function mapCheckoutPreview(rows: readonly ShopCartRow[]): ShopCheckoutPreview {
  const groups = new Map<string, ShopCartRow[]>();
  for (const row of rows) {
    const key = row.merchant_id ?? "";
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row]);
    else list.push(row);
  }

  const mapped = [...groups.entries()].map(([merchantId, groupRows]) => {
    const items = groupRows.map(mapCartItem);
    return {
      merchantId: merchantId.length > 0 ? merchantId : "unknown-merchant",
      merchantName: "DShop",
      items,
      goodsAmount: items.reduce((sum, item) => sum + item.subtotal, 0),
      freightAmount: 0,
    };
  });

  const goodsAmount = mapped.reduce((sum, group) => sum + group.goodsAmount, 0);

  return {
    groups: mapped,
    goodsAmount,
    freightAmount: 0,
    discountAmount: 0,
    payAmount: goodsAmount,
    currency: CURRENCY,
  };
}

/* -------------------------------------------------------------------------- */
/* 地址                                                                        */
/* -------------------------------------------------------------------------- */

/** 地址行 + 已解密手机号 → `ShopAddressSchema`。 */
export function mapAddress(
  row: {
    readonly id: string;
    readonly receiver_name: string;
    readonly province: string;
    readonly city: string;
    readonly district: string;
    readonly detail: string;
    readonly is_default: number;
  },
  receiverPhone: string,
): ShopAddress {
  return {
    id: row.id,
    receiverName: row.receiver_name,
    receiverPhone,
    province: row.province,
    city: row.city,
    district: row.district,
    detail: row.detail,
    isDefault: row.is_default === 1,
  };
}

/* -------------------------------------------------------------------------- */
/* 订单                                                                        */
/* -------------------------------------------------------------------------- */

/** 主单状态（**由子单聚合**，`docs/08` §8.3）。 */
export function orderStatusOf(subStatuses: readonly SubOrderStatus[]): OrderStatus {
  return aggregateOrderStatus(subStatuses);
}

/**
 * `address_snapshot` JSON → 未脱敏收件人。
 *
 * ⚠️ 解析失败时各字段兜底为 `-`，保持契约的 `min(1)` 要求，
 * **绝不**把 JSON 原文透出。
 */
export function mapOrderReceiver(snapshot: string): ShopOrderReceiver {
  const obj = parseJsonObject(snapshot);
  return {
    name: pickString(obj, "receiver_name") ?? "-",
    phone: pickString(obj, "receiver_phone") ?? "-",
    province: pickString(obj, "province") ?? "-",
    city: pickString(obj, "city") ?? "-",
    district: pickString(obj, "district") ?? "-",
    detail: pickString(obj, "detail") ?? "-",
  };
}

/** 快照行 → `OrderItemSchema`。 */
export function mapOrderItem(item: ShopOrderItemRow) {
  return {
    skuId: item.sku_id,
    title: item.title,
    spec: parseSkuSpec(item.spec) as SkuSpec,
    unitPrice: item.unit_price,
    quantity: item.quantity,
    subtotal: item.subtotal,
  };
}

/**
 * 子单行 + 其明细 → `ShopSubOrderSchema`。
 *
 * ⚠️ `express.traces` 的唯一来源是 `order_status_logs` 的 `kind='trace'` 行。
 * 本实现**未取该表**，故 `traces` 为空数组、`latestStatus` 用子单状态文案兜底
 * ——轨迹同步由 Cron 负责（`docs/08` §8.6），此处**不臆造轨迹**。
 */
export function mapSubOrder(
  row: ShopSubOrderRow,
  items: readonly ShopOrderItemRow[],
): ShopSubOrder {
  const expressNo = row.express_no;
  const hasExpress = expressNo !== null && expressNo.trim().length > 0;

  return {
    subOrderNo: row.sub_order_no,
    merchantName: row.merchant_name ?? "未知商户",
    merchantType: row.merchant_type ?? "vendor",
    status: row.status,
    statusText: SUB_ORDER_STATUS_TEXT[row.status],
    shipFrom: {
      storeName: row.store_name ?? row.merchant_name ?? "未知发货地",
      city: row.store_city ?? row.store_province ?? "未知城市",
    },
    express: hasExpress
      ? {
          company: row.express_company ?? "未知快递",
          companyCode: row.express_company_code ?? "UNKNOWN",
          no: expressNo,
          shippedAt: row.shipped_at,
          latestStatus: SUB_ORDER_STATUS_TEXT[row.status],
          latestStatusAt: row.shipped_at,
          traces: [],
        }
      : null,
    items: items.map(mapOrderItem),
  };
}

/**
 * 售后汇总（`openCount` / `refundedAmount`）。
 *
 * `openCount` 的判据是 `@dshop/shared` 的 `OPEN_AFTERSALE_STATUSES`；
 * `refundedAmount` 只累加 `REFUNDED` 的 `refund_amount`。
 */
export function mapAftersaleSummary(
  aftersales: readonly { readonly status: string; readonly refund_amount: number }[],
) {
  const open = new Set<string>(OPEN_AFTERSALE_STATUSES);
  let openCount = 0;
  let refundedAmount = 0;
  for (const row of aftersales) {
    if (open.has(row.status)) openCount += 1;
    if (row.status === AFTERSALE_STATUS.REFUNDED) refundedAmount += row.refund_amount;
  }
  return {
    hasAftersale: aftersales.length > 0,
    openCount,
    refundedAmount,
  };
}

/**
 * 订单详情聚合体 → `ShopOrderDetailSchema`。
 *
 * ⚠️ `subOrders` 契约要求 `min(1)`。历史脏数据（主单无子单）会导致空数组违反契约，
 * 此时**如实下发空数组**，由路由层的 Zod 校验暴露问题，而不是伪造一条假子单。
 */
export function mapOrderDetail(aggregate: ShopOrderDetailAggregate): ShopOrderDetail {
  const { order, subOrders, items, aftersales } = aggregate;
  const status = orderStatusOf(subOrders.map((s) => s.status));

  const itemsBySubOrder = new Map<string, ShopOrderItemRow[]>();
  for (const item of items) {
    const list = itemsBySubOrder.get(item.sub_order_id);
    if (list === undefined) itemsBySubOrder.set(item.sub_order_id, [item]);
    else list.push(item);
  }

  return {
    orderNo: order.order_no,
    status,
    statusText: ORDER_STATUS_TEXT[status],
    channel: order.channel,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    payAmount: order.pay_amount,
    currency: CURRENCY,
    receiver: mapOrderReceiver(order.address_snapshot),
    subOrders: subOrders.map((sub) => mapSubOrder(sub, itemsBySubOrder.get(sub.id) ?? [])),
    aftersaleSummary: mapAftersaleSummary(aftersales),
  };
}

/**
 * 列表项聚合体 → `ShopOrderListItemSchema`。
 *
 * `status` 取 `orders.status`（聚合结果的**物化值**，与详情页由子单实时聚合的口径一致；
 * 下单 / 支付 / 取消时都会同步写该列）。
 */
export function mapOrderListItem(aggregate: ShopOrderListAggregate): ShopOrderListItem {
  const { order, subOrderStatuses, items, aftersales } = aggregate;
  const status = order.status ?? orderStatusOf(subOrderStatuses);

  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const first = items[0];

  return {
    orderNo: order.order_no,
    status,
    statusText: ORDER_STATUS_TEXT[status],
    payAmount: order.pay_amount,
    itemSummary: first === undefined ? "无商品" : `${first.title} 等 ${itemCount} 件`,
    itemCount,
    createdAt: order.created_at,
    // 契约要求 positive：无子单的脏数据兜底为 1，避免整页 500
    subOrderCount: Math.max(subOrderStatuses.length, 1),
    allShipped:
      subOrderStatuses.length > 0 &&
      subOrderStatuses.every(
        (s) => s === SUB_ORDER_STATUS.SHIPPED || s === SUB_ORDER_STATUS.COMPLETED,
      ),
    hasOpenAftersale: mapAftersaleSummary(aftersales).openCount > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* 售后                                                                        */
/* -------------------------------------------------------------------------- */

/** 回寄地址（`aftersales.return_address` 的 JSON 原文 → 未脱敏结构）。 */
export function mapReturnAddress(snapshot: string | null): ShopOrderReceiver | null {
  if (snapshot === null || snapshot.trim().length === 0) return null;
  return mapOrderReceiver(snapshot);
}

/** 退款信息（无 `refunds` 行时按售后状态推导）。 */
export function mapRefund(aggregate: ShopAftersaleDetailAggregate) {
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
    status: aggregate.aftersale.status === AFTERSALE_STATUS.REFUNDED ? "SUCCESS" : "PENDING",
    refundNo: null,
    channel: null,
    arrivedAt: null,
    estimatedArrivalDays: null,
  };
}

/** 售后详情聚合体 → `ShopAftersaleDetailSchema`。 */
export function mapAftersaleDetail(aggregate: ShopAftersaleDetailAggregate): ShopAftersaleDetail {
  const { aftersale, logs } = aggregate;
  return {
    aftersaleNo: aftersale.aftersale_no,
    type: aftersale.type,
    typeText: AFTERSALE_TYPE_TEXT[aftersale.type],
    status: aftersale.status,
    statusText: AFTERSALE_STATUS_TEXT[aftersale.status],
    orderNo: aggregate.orderNo,
    subOrderNo: aggregate.subOrderNo,
    skuId: aftersale.sku_id,
    itemTitle: aftersale.item_title,
    quantity: aftersale.quantity,
    refundAmount: aftersale.refund_amount,
    currency: CURRENCY,
    reason: aftersale.reason,
    evidenceCount: aggregate.evidenceCount,
    createdAt: aftersale.created_at,
    deadlineAt: aftersale.deadline_at,
    returnAddress: mapReturnAddress(aftersale.return_address),
    returnExpress:
      aftersale.return_express_no !== null && aftersale.return_express_no.trim().length > 0
        ? {
            company: aftersale.return_express_company ?? "未知快递",
            no: aftersale.return_express_no,
            shippedAt: null,
          }
        : null,
    refund: mapRefund(aggregate),
    timeline: logs.map((log) => ({
      at: log.occurred_at,
      actor: log.actor_type,
      from: log.from_status,
      to: log.to_status,
      remark: log.remark,
    })),
  };
}

/** 售后列表行 → `ShopAftersaleListItemSchema`。 */
export function mapAftersaleListItem(row: ShopAftersaleListRow): ShopAftersaleListItem {
  const type = row.type as AftersaleType;
  const status = row.status as AftersaleStatus;
  return {
    aftersaleNo: row.aftersale_no,
    orderNo: row.order_no ?? row.aftersale_no,
    type,
    typeText: AFTERSALE_TYPE_TEXT[type],
    status,
    statusText: AFTERSALE_STATUS_TEXT[status],
    itemTitle: row.item_title,
    refundAmount: row.refund_amount,
    createdAt: row.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/* 会员                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 手机号脱敏（`MaskedPhoneSchema`：保留前 3 后 4）。
 *
 * C 端**不下发完整手机号**——`ShopUserSchema.phoneMasked` 本身就是脱敏形态，
 * 这是契约的字段级要求（与 `receiver` 的「完整下发」不同）。
 */
export function maskShopPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "000****";
  const prefix = digits.slice(0, 3).padStart(3, "0");
  const suffix = digits.slice(-4);
  return `${prefix}****${suffix}`;
}

/** 解析 `evidenceKeys` 为 `evidence_urls` 列的 JSON 串（只保留字符串项）。 */
export function evidenceUrlsJson(keys: readonly string[] | undefined): string {
  return JSON.stringify(parseStringArray(JSON.stringify(keys ?? [])));
}
