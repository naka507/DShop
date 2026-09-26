/**
 * 商户后台订单仓储（`/api/v1/merchant/orders`，`docs/06` §6 / `docs/08` §8.3）。
 *
 * ## 行级隔离在**本层 SQL 内**强制注入（`docs/09` §9.2）
 *
 * 每个查询的 `WHERE` 都含一段由 `merchantScopeClause()` 生成的商户条件，
 * 绑定值来自 `resolveMerchantScope()`（即 `merchant_members` 表 + JWT `mid`），
 * **不读取任何请求参数里的 `merchantId`**。因此：
 * - 商户 A 的令牌即使显式传入商户 B 的订单号，SQL 也匹配不到 → 路由回 404；
 * - 共享主单（多商户子单）只返回**本商户自己的子单**，不泄漏其他商户的履约信息。
 *
 * ## 主单可见性判据
 *
 * `orders` 表**没有** `merchant_id` 列（`packages/db/src/schema/trade.ts`），
 * 故主单对某商户可见 ⟺ 该主单下**至少有一个子单**属于该商户
 * （`EXISTS (SELECT 1 FROM sub_orders ...)`）。
 *
 * 设计约束同 `orders.ts`：原生 D1 API、显式列名、无 `SELECT *`。
 */

import { aggregateOrderStatus } from "@dshop/services";
import type { OrderStatus, SubOrderStatus } from "@dshop/shared";

import type { MerchantScope } from "../middleware/merchant-scope.js";
import { merchantScopeClause, placeholders } from "./merchant-scope-sql.js";

/* -------------------------------------------------------------------------- */
/* 行类型（snake_case，与 SQL 列一一对应）                                      */
/* -------------------------------------------------------------------------- */

/** `orders` 行（仅取商户后台需要的列）。 */
export interface MerchantOrderRow {
  readonly id: string;
  readonly order_no: string;
  readonly status: OrderStatus;
  readonly channel: string;
  readonly pay_amount: number;
  /** JSON 原文；**绝不下发**，仅用于脱敏出 `receiver`。 */
  readonly address_snapshot: string;
  readonly created_at: string;
  readonly paid_at: string | null;
}

/** `sub_orders` 行。 */
export interface MerchantSubOrderRow {
  readonly id: string;
  readonly sub_order_no: string;
  readonly order_id: string;
  readonly merchant_id: string;
  readonly store_id: string;
  readonly status: SubOrderStatus;
  readonly express_company: string | null;
  readonly express_company_code: string | null;
  readonly express_no: string | null;
  readonly shipped_at: string | null;
}

/** `order_items` 行（下单快照）。 */
export interface MerchantOrderItemRow {
  readonly id: string;
  readonly sub_order_id: string;
  readonly sku_id: string;
  readonly title: string;
  readonly image: string | null;
  readonly spec: string;
  readonly unit_price: number;
  readonly quantity: number;
  readonly subtotal: number;
}

/** `order_status_logs` 中 `kind='trace'` 的轨迹行。 */
export interface MerchantTraceRow {
  readonly sub_order_id: string | null;
  readonly remark: string | null;
  readonly occurred_at: string;
}

/** `aftersales` 行（仅汇总所需列）。 */
export interface MerchantOrderAftersaleRow {
  readonly id: string;
  readonly sub_order_id: string;
  readonly status: string;
  readonly refund_amount: number;
}

/** `stores` 行（`shipFrom` 来源）。 */
export interface MerchantStoreNameRow {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly province: string | null;
}

/** 列表项聚合体。 */
export interface MerchantOrderListRow {
  readonly order: MerchantOrderRow;
  readonly subOrders: readonly MerchantSubOrderRow[];
  readonly items: readonly MerchantOrderItemRow[];
  readonly aftersales: readonly MerchantOrderAftersaleRow[];
}

/** 详情聚合体。 */
export interface MerchantOrderDetailAggregate {
  readonly order: MerchantOrderRow;
  readonly subOrders: readonly MerchantSubOrderRow[];
  readonly stores: readonly MerchantStoreNameRow[];
  readonly items: readonly MerchantOrderItemRow[];
  readonly traces: readonly MerchantTraceRow[];
  readonly aftersales: readonly MerchantOrderAftersaleRow[];
}

/** `GET /merchant/orders` 的查询条件。 */
export interface ListMerchantOrdersInput {
  readonly scope: MerchantScope;
  readonly status?: string | undefined;
  readonly orderNo?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

/** 分页结果。 */
export interface MerchantOrderPage {
  readonly rows: readonly MerchantOrderListRow[];
  readonly total: number;
}

/* -------------------------------------------------------------------------- */
/* SQL 片段                                                                     */
/* -------------------------------------------------------------------------- */

const ORDER_COLUMNS =
  "o.id, o.order_no, o.status, o.channel, o.pay_amount, o.address_snapshot, o.created_at, o.paid_at";
const SUB_ORDER_COLUMNS =
  "s.id, s.sub_order_no, s.order_id, s.merchant_id, s.store_id, s.status, s.express_company, s.express_company_code, s.express_no, s.shipped_at";
const ORDER_ITEM_COLUMNS =
  "i.id, i.sub_order_id, i.sku_id, i.title, i.image, i.spec, i.unit_price, i.quantity, i.subtotal";

/** 主单可见性：存在属于可见商户的子单。 */
function orderVisibilityCondition(scope: MerchantScope): {
  clause: string;
  args: readonly string[];
} {
  const inner = merchantScopeClause(scope, "s.merchant_id");
  return {
    clause: `EXISTS (SELECT 1 FROM sub_orders s WHERE s.order_id = o.id AND ${inner.clause})`,
    args: inner.args,
  };
}

/* -------------------------------------------------------------------------- */
/* 列表                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 按 `created_at DESC, order_no DESC` 分页列出可见主单。
 *
 * `total` 与 `list` 用**同一段 `WHERE`**，避免两处条件漂移导致分页错位。
 */
export async function listMerchantOrders(
  db: D1Database,
  input: ListMerchantOrdersInput,
): Promise<MerchantOrderPage> {
  const visibility = orderVisibilityCondition(input.scope);
  const conditions: string[] = [visibility.clause];
  const args: unknown[] = [...visibility.args];

  if (input.status !== undefined) {
    conditions.push("o.status = ?");
    args.push(input.status);
  }
  if (input.orderNo !== undefined) {
    conditions.push("o.order_no = ?");
    args.push(input.orderNo);
  }

  const where = conditions.join(" AND ");
  const offset = (input.page - 1) * input.pageSize;

  const [countRow, orderRows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM orders o WHERE ${where}`)
      .bind(...args)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT ${ORDER_COLUMNS} FROM orders o
          WHERE ${where}
          ORDER BY o.created_at DESC, o.order_no DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...args, input.pageSize, offset)
      .all<MerchantOrderRow>(),
  ]);

  const page = orderRows.results;
  if (page.length === 0) {
    return { rows: [], total: countRow?.total ?? 0 };
  }

  const scoped = await loadScopedChildren(db, input.scope, page);
  return {
    rows: page.map((order) => ({
      order,
      subOrders: scoped.subOrdersByOrder.get(order.id) ?? [],
      items: scoped.itemsByOrder.get(order.id) ?? [],
      aftersales: scoped.aftersalesByOrder.get(order.id) ?? [],
    })),
    total: countRow?.total ?? 0,
  };
}

/**
 * 取某页主单的**受隔离的子单 / 商品快照 / 售后**。
 *
 * 关键：子单查询**同样**带 `merchant_id` 条件——否则商户 A 会在共享主单里
 * 看到商户 B 的子单（这是比「看不到订单」更隐蔽的越权）。
 */
async function loadScopedChildren(
  db: D1Database,
  scope: MerchantScope,
  orders: readonly MerchantOrderRow[],
): Promise<{
  subOrdersByOrder: Map<string, MerchantSubOrderRow[]>;
  itemsByOrder: Map<string, MerchantOrderItemRow[]>;
  aftersalesByOrder: Map<string, MerchantOrderAftersaleRow[]>;
}> {
  const orderIds = orders.map((row) => row.id);
  const scopeClause = merchantScopeClause(scope, "s.merchant_id");
  const orderPh = placeholders(orderIds.length);

  const subOrderRows = await db
    .prepare(
      `SELECT ${SUB_ORDER_COLUMNS} FROM sub_orders s
        WHERE s.order_id IN (${orderPh}) AND ${scopeClause.clause}
        ORDER BY s.sub_order_no ASC`,
    )
    .bind(...orderIds, ...scopeClause.args)
    .all<MerchantSubOrderRow>();

  const subOrderIds = subOrderRows.results.map((row) => row.id);
  const subPh = subOrderIds.length > 0 ? placeholders(subOrderIds.length) : null;

  const [itemRows, aftersaleRows] = await Promise.all([
    subPh === null
      ? Promise.resolve({ results: [] as MerchantOrderItemRow[] })
      : db
          .prepare(
            `SELECT ${ORDER_ITEM_COLUMNS} FROM order_items i
              WHERE i.sub_order_id IN (${subPh})
              ORDER BY i.created_at ASC, i.id ASC`,
          )
          .bind(...subOrderIds)
          .all<MerchantOrderItemRow>(),
    subPh === null
      ? Promise.resolve({ results: [] as MerchantOrderAftersaleRow[] })
      : db
          .prepare(
            `SELECT id, sub_order_id, status, refund_amount FROM aftersales
              WHERE sub_order_id IN (${subPh})
              ORDER BY created_at ASC`,
          )
          .bind(...subOrderIds)
          .all<MerchantOrderAftersaleRow>(),
  ]);

  const subOrdersByOrder = new Map<string, MerchantSubOrderRow[]>();
  for (const row of subOrderRows.results) {
    const list = subOrdersByOrder.get(row.order_id);
    if (list === undefined) subOrdersByOrder.set(row.order_id, [row]);
    else list.push(row);
  }

  const itemsByOrder = new Map<string, MerchantOrderItemRow[]>();
  for (const item of itemRows.results) {
    const subOrder = subOrderRows.results.find((row) => row.id === item.sub_order_id);
    if (subOrder === undefined) continue;
    const list = itemsByOrder.get(subOrder.order_id);
    if (list === undefined) itemsByOrder.set(subOrder.order_id, [item]);
    else list.push(item);
  }

  const aftersalesByOrder = new Map<string, MerchantOrderAftersaleRow[]>();
  for (const aftersale of aftersaleRows.results) {
    const subOrder = subOrderRows.results.find((row) => row.id === aftersale.sub_order_id);
    if (subOrder === undefined) continue;
    const list = aftersalesByOrder.get(subOrder.order_id);
    if (list === undefined) aftersalesByOrder.set(subOrder.order_id, [aftersale]);
    else list.push(aftersale);
  }

  return { subOrdersByOrder, itemsByOrder, aftersalesByOrder };
}

/* -------------------------------------------------------------------------- */
/* 详情                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 按主单号取详情（**带行级隔离**）。
 *
 * 查不到 → `null`。**注意**：不属于当前商户的订单同样返回 `null`，
 * 路由据此回 `ERR_MERCHANT_ORDER_NOT_FOUND`（404 而非 403，`docs/09` §9.2
 * 的防枚举口径：不区分「不存在」与「不属于你」）。
 */
export async function findMerchantOrderByNo(
  db: D1Database,
  scope: MerchantScope,
  orderNo: string,
): Promise<MerchantOrderDetailAggregate | null> {
  const visibility = orderVisibilityCondition(scope);
  const order = await db
    .prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders o
        WHERE o.order_no = ? AND ${visibility.clause}
        LIMIT 1`,
    )
    .bind(orderNo, ...visibility.args)
    .first<MerchantOrderRow>();
  if (order === null) return null;

  const scopeClause = merchantScopeClause(scope, "s.merchant_id");
  const subOrderRows = await db
    .prepare(
      `SELECT ${SUB_ORDER_COLUMNS} FROM sub_orders s
        WHERE s.order_id = ? AND ${scopeClause.clause}
        ORDER BY s.sub_order_no ASC`,
    )
    .bind(order.id, ...scopeClause.args)
    .all<MerchantSubOrderRow>();

  const subOrderIds = subOrderRows.results.map((row) => row.id);
  const storeIds = [...new Set(subOrderRows.results.map((row) => row.store_id))];
  const subPh = subOrderIds.length > 0 ? placeholders(subOrderIds.length) : null;
  const storePh = storeIds.length > 0 ? placeholders(storeIds.length) : null;

  const [itemRows, traceRows, aftersaleRows, storeRows] = await Promise.all([
    subPh === null
      ? Promise.resolve({ results: [] as MerchantOrderItemRow[] })
      : db
          .prepare(
            `SELECT ${ORDER_ITEM_COLUMNS} FROM order_items i
              WHERE i.sub_order_id IN (${subPh})
              ORDER BY i.created_at ASC, i.id ASC`,
          )
          .bind(...subOrderIds)
          .all<MerchantOrderItemRow>(),
    subPh === null
      ? Promise.resolve({ results: [] as MerchantTraceRow[] })
      : db
          .prepare(
            `SELECT sub_order_id, remark, occurred_at FROM order_status_logs
              WHERE sub_order_id IN (${subPh}) AND kind = 'trace'
              ORDER BY occurred_at ASC, id ASC`,
          )
          .bind(...subOrderIds)
          .all<MerchantTraceRow>(),
    subPh === null
      ? Promise.resolve({ results: [] as MerchantOrderAftersaleRow[] })
      : db
          .prepare(
            `SELECT id, sub_order_id, status, refund_amount FROM aftersales
              WHERE sub_order_id IN (${subPh})
              ORDER BY created_at ASC`,
          )
          .bind(...subOrderIds)
          .all<MerchantOrderAftersaleRow>(),
    storePh === null
      ? Promise.resolve({ results: [] as MerchantStoreNameRow[] })
      : db
          .prepare(`SELECT id, name, city, province FROM stores WHERE id IN (${storePh})`)
          .bind(...storeIds)
          .all<MerchantStoreNameRow>(),
  ]);

  return {
    order,
    subOrders: subOrderRows.results,
    stores: storeRows.results,
    items: itemRows.results,
    traces: traceRows.results,
    aftersales: aftersaleRows.results,
  };
}

/** 主单状态（**由子单聚合**，`docs/08` §8.3）。 */
export function merchantOrderStatus(subOrders: readonly MerchantSubOrderRow[]): OrderStatus {
  return aggregateOrderStatus(subOrders.map((row) => row.status));
}
