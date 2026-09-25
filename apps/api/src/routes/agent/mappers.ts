/**
 * Agent 只读契约的行 → 契约载荷映射（纯函数，无 I/O，便于直接单测）。
 *
 * 分层意图：
 * - `repositories/*` 只负责取数（原生 D1，显式列名）
 * - 本文件只负责**取值 + 脱敏 + 组装**，输出形状严格对齐
 *   `packages/shared/src/contracts/agent.ts` 的 `Agent*Schema`
 * - `routes/agent/*` 只负责参数校验、取数与响应封装
 *
 * 硬性红线（`docs/07` §7.8.2）：
 * - `address_snapshot` 原文**绝不下发**，只经 `maskAddressSnapshot()` 出 `{region, detail}`
 * - 姓名 / 手机号一律走 `maskName()` / `maskPhone()`（本文件对不满足契约正则的边界值做兜底）
 * - `evidence_urls` 只出计数
 */

import {
  AFTERSALE_STATUS,
  AFTERSALE_STATUS_TEXT,
  AFTERSALE_TYPE_TEXT,
  CURRENCY,
  OPEN_AFTERSALE_STATUSES,
  ORDER_STATUS_TEXT,
  REFUND_STATUS,
  SUB_ORDER_STATUS,
  SUB_ORDER_STATUS_TEXT,
} from "@dshop/shared";
import type {
  AgentAftersaleDetail,
  AgentOrderDetail,
  AgentOrderList,
  AgentOrderListItem,
  AgentPolicies,
  AgentPolicyItem,
  AgentProductSpecs,
  AgentProductStock,
  AgentStockSku,
  AftersaleSummary,
  Express,
  OrderChannel,
  OrderStatus,
  ProductStatus,
  Receiver,
  ReturnAddress,
  SkuSpec,
  SubOrderStatus,
} from "@dshop/shared";
import { aggregateOrderStatus, availableStock, maskAddressSnapshot, maskName, maskPhone } from "@dshop/services";

import { parseJsonObject, parseSkuSpec, parseStringArray, pickString, contentHashOf } from "../../repositories/json.js";
import type {
  OrderAggregate,
  OrderItemRow,
  OrderListAggregate,
  SubOrderAggregate,
} from "../../repositories/orders.js";
import type {
  ProductSkuRow,
  ProductSpecsAggregate,
  ProductStockAggregate,
} from "../../repositories/products.js";
import type { AftersaleAggregate, PolicyRow } from "../../repositories/aftersales.js";

/* -------------------------------------------------------------------------- */
/* 契约正则（与 `contracts/common.ts` 保持一致）                                */
/* -------------------------------------------------------------------------- */

const MASKED_NAME_PATTERN = /^.\*{1,2}$/;
const MASKED_PHONE_PATTERN = /^\d{3,4}\*{4}\d{0,4}$/;

/**
 * 姓名脱敏并保证满足 `MaskedNameSchema`（`^.\\*{1,2}$`）。
 *
 * `maskName()` 对**单字姓名**返回 `张`（不满足契约，契约要求至少 1 个 `*`），
 * 故此处对不满足正则的结果兜底为「首字 + `**`」——**只会遮得更多，绝不泄漏更多**。
 */
export function maskNameForContract(raw: string | null | undefined): string {
  const masked = maskName(raw);
  if (masked !== null && MASKED_NAME_PATTERN.test(masked)) return masked;
  const first = (raw ?? "").trim().charAt(0);
  return `${first.length > 0 ? first : "*"}**`;
}

/**
 * 手机号脱敏并保证满足 `MaskedPhoneSchema`（`^\\d{3,4}\\*{4}\\d{0,4}$`）。
 *
 * `maskPhone()` 对 **11 位手机号**产出 `138****8888`（满足契约）；
 * 对固定电话（如 12 位 `057188880000`）产出 `05********00`（星号数不符契约）。
 * 按 `docs/07` §7.8.2「固定电话保留区号」的规则兜底为 `0571****0000`。
 */
export function maskPhoneForContract(raw: string | null | undefined): string {
  const masked = maskPhone(raw);
  if (masked !== null && MASKED_PHONE_PATTERN.test(masked)) return masked;

  let digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("86")) digits = digits.slice(2);
  if (digits.length === 0) return "000****";
  const prefix = digits.slice(0, digits.length > 11 ? 4 : 3).padStart(3, "0");
  const suffix = digits.slice(-4);
  return `${prefix}****${suffix}`;
}

/**
 * 地址快照 → `ReceiverSchema`（`receiver` / `returnAddress` 共用）。
 *
 * `region` 保留省/市/区，`addressMasked` = `region + " ***"`；原文永不出现。
 */
export function maskReceiverSnapshot(snapshot: string | null | undefined): Receiver {
  const masked = maskAddressSnapshot(snapshot);
  const obj = parseJsonObject(snapshot);
  const region = masked.region.trim().length > 0 ? masked.region.trim() : "***";
  return {
    name: maskNameForContract(pickString(obj, "receiver_name")),
    phone: maskPhoneForContract(pickString(obj, "receiver_phone")),
    region,
    addressMasked: `${region} ***`,
  };
}

/* -------------------------------------------------------------------------- */
/* §7.2 GET /orders/{orderNo}                                                   */
/* -------------------------------------------------------------------------- */

/** 轨迹兜底文案（`ExpressTraceSchema.desc` 要求 `min(1)`）。 */
const TRACE_FALLBACK_DESC = "物流信息更新";

function mapExpress(sub: SubOrderAggregate): Express | null {
  const { subOrder, traces } = sub;
  const expressNo = subOrder.express_no;
  if (expressNo === null || expressNo.trim().length === 0) return null;

  const lastTrace = traces[traces.length - 1];
  const latestRemark = lastTrace?.remark ?? null;

  return {
    company: subOrder.express_company ?? "未知快递",
    companyCode: subOrder.express_company_code ?? "UNKNOWN",
    no: expressNo,
    shippedAt: subOrder.shipped_at,
    latestStatus:
      latestRemark !== null && latestRemark.trim().length > 0
        ? latestRemark
        : SUB_ORDER_STATUS_TEXT[subOrder.status],
    latestStatusAt: lastTrace?.occurred_at ?? subOrder.shipped_at,
    traces: traces.map((trace) => ({
      time: trace.occurred_at,
      desc:
        trace.remark !== null && trace.remark.trim().length > 0
          ? trace.remark
          : TRACE_FALLBACK_DESC,
    })),
  };
}

function mapOrderItem(item: OrderItemRow) {
  return {
    skuId: item.sku_id,
    title: item.title,
    spec: parseSkuSpec(item.spec) as SkuSpec,
    unitPrice: item.unit_price,
    quantity: item.quantity,
    subtotal: item.subtotal,
  };
}

/** 主单状态（**由子单聚合**，`docs/08` §8.3）。 */
export function orderStatusOf(subStatuses: readonly SubOrderStatus[]): OrderStatus {
  return aggregateOrderStatus(subStatuses);
}

/**
 * 售后汇总。
 *
 * `openCount` 的判据是 `packages/shared` 的 `OPEN_AFTERSALE_STATUSES`
 * （= `PENDING_MERCHANT` / `WAIT_BUYER_RETURN` / `BUYER_RETURNED` /
 * `MERCHANT_RECEIVED` / `REFUNDING`）；其余 `REFUNDED` / `REJECTED` / `CANCELLED`
 * 视为已终结。`refundedAmount` 只累加 `REFUNDED` 的 `refund_amount`。
 */
export function mapAftersaleSummary(
  aftersales: readonly { readonly status: string; readonly refund_amount: number }[],
): AftersaleSummary {
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

/** 主单详情聚合体 → `AgentOrderDetailSchema`。 */
export function mapOrderDetail(aggregate: OrderAggregate): AgentOrderDetail {
  const { order, subOrders, aftersales } = aggregate;
  const status = orderStatusOf(subOrders.map((s) => s.subOrder.status));

  return {
    orderNo: order.order_no,
    status,
    statusText: ORDER_STATUS_TEXT[status],
    channel: order.channel as OrderChannel,
    createdAt: order.created_at,
    paidAt: order.paid_at,
    payAmount: order.pay_amount,
    currency: CURRENCY,
    receiver: maskReceiverSnapshot(order.address_snapshot),
    subOrders: subOrders.map((sub) => ({
      subOrderNo: sub.subOrder.sub_order_no,
      merchantName: sub.merchant?.name ?? "未知商户",
      merchantType: sub.merchant?.type ?? "vendor",
      status: sub.subOrder.status,
      statusText: SUB_ORDER_STATUS_TEXT[sub.subOrder.status],
      shipFrom: {
        storeName: sub.store?.name ?? sub.merchant?.name ?? "未知发货地",
        city: sub.store?.city ?? sub.store?.province ?? "未知城市",
      },
      express: mapExpress(sub),
      items: sub.items.map(mapOrderItem),
    })),
    aftersaleSummary: mapAftersaleSummary(aftersales),
  };
}

/* -------------------------------------------------------------------------- */
/* §7.3 GET /orders                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 列表项摘要文案：`<首件标题> 等 <总件数> 件`。
 *
 * ⚠️ **与文档示例略有差异**：`docs/07` §7.3 的示例为
 * `"极光 Pro 真无线降噪耳机 等 1 件商品"`（含「商品」二字）。
 * 本实现按实施任务书定案为「… 等 N 件」（`itemSummary` 契约仅约束 `min(1)`）。
 */
export function itemSummaryOf(items: readonly OrderItemRow[]): {
  itemSummary: string;
  itemCount: number;
} {
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const first = items[0];
  if (first === undefined) return { itemSummary: "无商品", itemCount };
  return { itemSummary: `${first.title} 等 ${itemCount} 件`, itemCount };
}

/** 是否全部子单已发货或已完成（`allShipped`）。 */
export function isAllShipped(subStatuses: readonly SubOrderStatus[]): boolean {
  if (subStatuses.length === 0) return false;
  return subStatuses.every(
    (status) => status === SUB_ORDER_STATUS.SHIPPED || status === SUB_ORDER_STATUS.COMPLETED,
  );
}

/** 是否存在未终结售后（`hasOpenAftersale`）。 */
export function hasOpenAftersale(
  aftersales: readonly { readonly status: string }[],
): boolean {
  const open = new Set<string>(OPEN_AFTERSALE_STATUSES);
  return aftersales.some((row) => open.has(row.status));
}

/** 列表项聚合体 → `AgentOrderListItemSchema`。 */
export function mapOrderListItem(aggregate: OrderListAggregate): AgentOrderListItem {
  const status = orderStatusOf(aggregate.subOrderStatuses);
  const { itemSummary, itemCount } = itemSummaryOf(aggregate.items);
  return {
    orderNo: aggregate.order.order_no,
    status,
    statusText: ORDER_STATUS_TEXT[status],
    payAmount: aggregate.order.pay_amount,
    itemSummary,
    itemCount,
    createdAt: aggregate.order.created_at,
    subOrderCount: aggregate.subOrderCount,
    allShipped: isAllShipped(aggregate.subOrderStatuses),
    hasOpenAftersale: hasOpenAftersale(aggregate.aftersales),
  };
}

/**
 * 空列表哨兵 `userId`。
 *
 * ⚠️ **契约张力**：`AgentOrderListSchema.userId` 是**必填的 `UlidSchema`**，
 * 但 `phone` 查不到用户时按实施任务书要求返回**空列表而非 404**，
 * 此时并不存在真实 `userId`。本实现用「全零 ULID」作为哨兵
 * （26 位、Crocksford Base32 合法、不与真实 ULID 冲突），并在汇报中登记。
 */
export const UNKNOWN_USER_ID = "00000000000000000000000000";

/** 列表聚合结果 → `AgentOrderListSchema`。 */
export function mapOrderList(
  userId: string,
  rows: readonly OrderListAggregate[],
  nextCursor: string | null,
  hasMore: boolean,
): AgentOrderList {
  return {
    userId,
    list: rows.map(mapOrderListItem),
    nextCursor,
    hasMore,
  };
}

/* -------------------------------------------------------------------------- */
/* §7.4 GET /products/{spuId}/specs                                             */
/* -------------------------------------------------------------------------- */

/**
 * 参数分组聚合。
 *
 * - 分组**顺序**：按组内最小 `sort_order` 升序（并列时按组名字典序，保证稳定）
 * - 组内条目顺序：`sort_order` 升序（SQL 已排序，此处保持）
 */
export function groupAttrs(
  attrs: readonly {
    readonly group_name: string;
    readonly attr_name: string;
    readonly attr_value: string;
    readonly unit: string | null;
    readonly sort_order: number;
  }[],
): { groupName: string; attrs: { name: string; value: string; unit: string | null }[] }[] {
  const groups = new Map<string, { minSort: number; attrs: { name: string; value: string; unit: string | null }[] }>();
  for (const attr of attrs) {
    const existing = groups.get(attr.group_name);
    const entry = { name: attr.attr_name, value: attr.attr_value, unit: attr.unit };
    if (existing === undefined) {
      groups.set(attr.group_name, { minSort: attr.sort_order, attrs: [entry] });
    } else {
      existing.minSort = Math.min(existing.minSort, attr.sort_order);
      existing.attrs.push(entry);
    }
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].minSort - b[1].minSort || a[0].localeCompare(b[0]))
    .map(([groupName, entry]) => ({ groupName, attrs: entry.attrs }));
}

/**
 * 规格维度聚合：从各 SKU 的 `spec` JSON 取键（维度名）与取值，**去重且保持首次出现顺序**。
 */
export function buildSpecDimensions(
  skus: readonly { readonly spec: string }[],
): { name: string; values: string[] }[] {
  const order: string[] = [];
  const values = new Map<string, Set<string>>();
  for (const sku of skus) {
    for (const [key, value] of Object.entries(parseSkuSpec(sku.spec))) {
      let set = values.get(key);
      if (set === undefined) {
        set = new Set<string>();
        values.set(key, set);
        order.push(key);
      }
      set.add(value);
    }
  }
  return order.map((name) => ({ name, values: [...(values.get(name) ?? [])] }));
}

/** 规格 SKU → `AgentSpecSkuSchema`（**不含库存数值**，仅 `inStock`）。 */
export function mapSpecSku(sku: ProductSkuRow) {
  return {
    skuId: sku.id,
    skuCode: sku.sku_code,
    spec: parseSkuSpec(sku.spec) as SkuSpec,
    price: sku.price,
    // `market_price` 可空，契约要求非空金额 → 兜底为 `price`
    marketPrice: sku.market_price ?? sku.price,
    status: sku.status,
    inStock: availableStock({ stock: sku.stock, lockedStock: sku.locked_stock }) > 0,
  };
}

/**
 * `/specs` 聚合体 → `AgentProductSpecsSchema`。
 *
 * `contentHash` 覆盖除自身以外的**全部下发内容**（含 `updatedAt` 与 SKU 可售性），
 * 使 PiEcho 能按哈希感知任何变更。
 */
export async function mapProductSpecs(
  aggregate: ProductSpecsAggregate,
): Promise<AgentProductSpecs> {
  const { product, attrs, skus } = aggregate;
  const base = {
    spuId: product.id,
    title: product.title,
    subtitle: product.subtitle,
    brand: product.brand,
    categoryPath: parseStringArray(product.category_path).filter((p) => p.length > 0),
    status: product.status as ProductStatus,
    mainImage: product.main_image,
    updatedAt: product.updated_at,
    attrGroups: groupAttrs(attrs),
    specDimensions: buildSpecDimensions(skus),
    skus: skus.map(mapSpecSku),
  };
  return { ...base, contentHash: await contentHashOf(base) };
}

/* -------------------------------------------------------------------------- */
/* §7.5 GET /products/{spuId}/stock                                             */
/* -------------------------------------------------------------------------- */

/** 库存 SKU → `AgentStockSkuSchema`（`stock` 是**可售** = `stock - locked_stock`）。 */
export function mapStockSku(sku: ProductSkuRow): AgentStockSku {
  const stock = availableStock({ stock: sku.stock, lockedStock: sku.locked_stock });
  return {
    skuId: sku.id,
    skuCode: sku.sku_code,
    spec: parseSkuSpec(sku.spec) as SkuSpec,
    stock,
    inStock: stock > 0,
    restockEta: sku.restock_eta,
  };
}

/**
 * `/stock` 聚合体 → `AgentProductStockSchema`。
 *
 * - `totalStock` = 目标 SKU 集合的可售之和（未指定 `skuId` 时为全部 SKU）
 * - `available` = `checkQuantity <= totalStock`（指定 `skuId` 时即该 SKU 的可售）
 */
export function mapProductStock(
  aggregate: ProductStockAggregate,
  checkQuantity: number,
  skuId?: string | undefined,
): AgentProductStock {
  const targetSkus =
    skuId === undefined ? aggregate.skus : aggregate.skus.filter((sku) => sku.id === skuId);
  const mapped = targetSkus.map(mapStockSku);
  const totalStock = mapped.reduce((sum, sku) => sum + sku.stock, 0);

  return {
    spuId: aggregate.product.id,
    status: aggregate.product.status as ProductStatus,
    checkQuantity,
    available: totalStock >= checkQuantity,
    totalStock,
    updatedAt: aggregate.product.updated_at,
    shipFrom: aggregate.stores.map((store) => ({
      storeId: store.id,
      storeName: store.name,
      type: store.type,
      city: store.city ?? store.province ?? "未知城市",
      province: store.province ?? "未知省份",
      supportsPickup: store.supports_pickup === 1,
    })),
    skus: mapped,
  };
}

/* -------------------------------------------------------------------------- */
/* §7.6 GET /aftersales/{aftersaleNo}                                           */
/* -------------------------------------------------------------------------- */

/** 政策正文 → 一行摘要（去掉 markdown 标题符号，截断 80 字）。 */
export function policySummary(content: string): string | null {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith(">"));
  if (line === undefined) return null;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** 退款信息：无 `refunds` 行时按售后状态推导 `status`，其余字段为 `null`。 */
export function mapRefund(
  aggregate: AftersaleAggregate,
): AgentAftersaleDetail["refund"] {
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
      aggregate.aftersale.status === AFTERSALE_STATUS.REFUNDED
        ? REFUND_STATUS.SUCCESS
        : REFUND_STATUS.PENDING,
    refundNo: null,
    channel: null,
    arrivedAt: null,
    estimatedArrivalDays: null,
  };
}

/**
 * `/aftersales/{aftersaleNo}` 聚合体 → `AgentAftersaleDetailSchema`。
 *
 * `evidenceCount` 来自仓储的**计数专用查询**；`evidence_urls` 原文不进入本层。
 * `returnAddress` 仅在 `WAIT_BUYER_RETURN` 及之后有值，且同样经脱敏。
 */
export function mapAftersaleDetail(aggregate: AftersaleAggregate): AgentAftersaleDetail {
  const { aftersale, logs, policy } = aggregate;
  const returnAddress: ReturnAddress | null =
    aftersale.return_address !== null ? maskReceiverSnapshot(aftersale.return_address) : null;

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
    returnAddress,
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
    policy:
      policy === null
        ? null
        : {
            category: policy.category,
            title: policy.title,
            version: policy.version,
            summary: policySummary(policy.content),
          },
  };
}

/* -------------------------------------------------------------------------- */
/* §7.7 GET /policies/{category}                                                */
/* -------------------------------------------------------------------------- */

function mapPolicyItem(row: PolicyRow): AgentPolicyItem {
  return {
    policyId: row.id,
    title: row.title,
    version: row.version,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    updatedAt: row.updated_at,
    content: row.content,
    tags: parseStringArray(row.tags),
  };
}

/** 政策条款列表 → `AgentPoliciesSchema`（`contentHash` 覆盖全部条款内容）。 */
export async function mapPolicies(
  category: AgentPolicies["category"],
  rows: readonly PolicyRow[],
): Promise<AgentPolicies> {
  const items = rows.map(mapPolicyItem);
  return { category, contentHash: await contentHashOf(items), items };
}
