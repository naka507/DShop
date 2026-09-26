/**
 * 订单仓储（Agent 只读契约 `docs/07` §7.2 / §7.3）。
 *
 * 设计约束：
 * - **只用 `db.prepare(...).bind(...)` 原生 D1 API**，不用 Drizzle 查询构造器——
 *   SQL 显式可审计，列名一律 snake_case。
 * - **每个查询显式列出所需列**，禁止 `SELECT *`（防敏感列泄漏：
 *   `address_snapshot` 原文、`raw_callback`、`cost_price` 等永不出库）。
 * - `orders.address_snapshot` **必须**取出（`receiver` 脱敏的唯一来源），
 *   但脱敏在路由层完成，本层返回原始行、不做下发决策。
 */

import type { AftersaleStatus, OrderStatus, SubOrderStatus } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 行类型（snake_case，与 SQL 列一一对应）                                      */
/* -------------------------------------------------------------------------- */

/** `orders` 行（仅取 Agent 需要的列）。 */
export interface OrderRow {
  readonly id: string;
  readonly order_no: string;
  readonly user_id: string;
  readonly status: OrderStatus;
  readonly pay_amount: number;
  /** JSON 原文；**绝不下发**，仅用于脱敏出 `receiver`。 */
  readonly address_snapshot: string;
  readonly channel: string;
  readonly paid_at: string | null;
  readonly created_at: string;
}

/** `sub_orders` 行。 */
export interface SubOrderRow {
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
export interface OrderItemRow {
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
export interface OrderTraceRow {
  readonly sub_order_id: string | null;
  readonly remark: string | null;
  readonly occurred_at: string;
}

/** `merchants` 行（仅 name/type）。 */
export interface MerchantRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

/** `stores` 行（`shipFrom` 来源）。 */
export interface StoreRow {
  readonly id: string;
  readonly merchant_id: string;
  readonly name: string;
  readonly type: string;
  readonly province: string | null;
  readonly city: string | null;
  readonly district: string | null;
}

/** `aftersales` 行（仅汇总所需列）。 */
export interface OrderAftersaleRow {
  readonly id: string;
  readonly order_id: string;
  readonly status: AftersaleStatus;
  readonly refund_amount: number;
}

/** 子单聚合体。 */
export interface SubOrderAggregate {
  readonly subOrder: SubOrderRow;
  readonly merchant: MerchantRow | null;
  readonly store: StoreRow | null;
  readonly items: readonly OrderItemRow[];
  readonly traces: readonly OrderTraceRow[];
}

/** 主单聚合体（`GET /orders/{orderNo}` 的单次取数结果）。 */
export interface OrderAggregate {
  readonly order: OrderRow;
  readonly subOrders: readonly SubOrderAggregate[];
  readonly aftersales: readonly OrderAftersaleRow[];
}

/** 列表项聚合体（`GET /orders` 的单次取数结果）。 */
export interface OrderListAggregate {
  readonly order: OrderRow;
  readonly subOrderStatuses: readonly SubOrderStatus[];
  readonly subOrderCount: number;
  readonly items: readonly OrderItemRow[];
  readonly aftersales: readonly OrderAftersaleRow[];
}

/** 列表分页结果。 */
export interface OrderListResult {
  readonly rows: readonly OrderListAggregate[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** `GET /orders` 的查询条件。 */
export interface ListOrdersInput {
  readonly userId: string;
  readonly statuses?: readonly string[] | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

/**
 * 游标格式非法。
 *
 * 调用方**必须**把它转成 `400` + `40001`，不可静默降级为「空列表」——
 * 否则 Agent 会把「游标坏了」误读成「该用户没有订单」，是危险的语义混淆。
 */
export class InvalidOrderCursorError extends Error {
  constructor(raw: string) {
    super(`cursor 格式非法：${raw}`);
    this.name = "InvalidOrderCursorError";
  }
}

/* -------------------------------------------------------------------------- */
/* 游标（base64url 编码的 `<created_at>|<order_no>`）                           */
/* -------------------------------------------------------------------------- */

/** 游标内部载荷。 */
export interface OrderCursor {
  readonly createdAt: string;
  readonly orderNo: string;
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (normalized.length % 4)) % 4;
    const binary = atob(normalized + "=".repeat(padding));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 编码游标：`base64url("<created_at>|<order_no>")`。
 *
 * ⚠️ **文档未定义**：`docs/07` §7.3 的 `nextCursor` 示例是 base64 的
 * `{"t":1758345000000,"id":"01J9Zac..."}`；本实现按实施任务书定案为
 * `<created_at>|<order_no>` 的点分串（`CursorSchema` 只约束为不透明非空字符串）。
 */
export function encodeOrderCursor(cursor: OrderCursor): string {
  return toBase64Url(`${cursor.createdAt}|${cursor.orderNo}`);
}

/** 解码游标；格式非法返回 `null`（调用方据此回 `40001`）。 */
export function decodeOrderCursor(raw: string): OrderCursor | null {
  const decoded = fromBase64Url(raw.trim());
  if (decoded === null) return null;
  const index = decoded.indexOf("|");
  if (index <= 0) return null;
  const createdAt = decoded.slice(0, index);
  const orderNo = decoded.slice(index + 1);
  if (createdAt.length === 0 || orderNo.length === 0) return null;
  return { createdAt, orderNo };
}

/* -------------------------------------------------------------------------- */
/* SQL 片段                                                                     */
/* -------------------------------------------------------------------------- */

const ORDER_COLUMNS =
  "id, order_no, user_id, status, pay_amount, address_snapshot, channel, paid_at, created_at";
const SUB_ORDER_COLUMNS =
  "id, sub_order_no, order_id, merchant_id, store_id, status, express_company, express_company_code, express_no, shipped_at";
const ORDER_ITEM_COLUMNS =
  "id, sub_order_id, sku_id, title, image, spec, unit_price, quantity, subtotal";

/** 生成 `?, ?, ...` 占位串。 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** 轨迹最多下发条数（`ExpressSchema.traces` 上限，`docs/07` §7.2）。 */
export const EXPRESS_TRACE_LIMIT = 10;

/* -------------------------------------------------------------------------- */
/* 取数                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 按主单号一次取齐：主单 + 全部子单 + 每子单的 items 与轨迹 + 子单的商户/门店 + 该主单的售后单。
 *
 * 查不到主单返回 `null`（路由据此回 `40401`）。
 */
export async function findOrderByNo(
  db: D1Database,
  orderNo: string,
): Promise<OrderAggregate | null> {
  const order = await db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE order_no = ? LIMIT 1`)
    .bind(orderNo)
    .first<OrderRow>();
  if (order === null) return null;

  const [subOrderRows, itemRows, traceRows, aftersaleRows] = await Promise.all([
    db
      .prepare(
        `SELECT ${SUB_ORDER_COLUMNS} FROM sub_orders WHERE order_id = ? ORDER BY sub_order_no ASC`,
      )
      .bind(order.id)
      .all<SubOrderRow>(),
    db
      .prepare(
        `SELECT ${ORDER_ITEM_COLUMNS} FROM order_items WHERE order_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .bind(order.id)
      .all<OrderItemRow>(),
    db
      .prepare(
        `SELECT sub_order_id, remark, occurred_at
           FROM order_status_logs
          WHERE order_id = ? AND kind = 'trace'
          ORDER BY occurred_at ASC, id ASC`,
      )
      .bind(order.id)
      .all<OrderTraceRow>(),
    db
      .prepare(
        `SELECT id, order_id, status, refund_amount FROM aftersales WHERE order_id = ? ORDER BY created_at ASC`,
      )
      .bind(order.id)
      .all<OrderAftersaleRow>(),
  ]);

  const subOrders = subOrderRows.results;

  const merchantIds = [...new Set(subOrders.map((s) => s.merchant_id))];
  const storeIds = [...new Set(subOrders.map((s) => s.store_id))];

  const [merchantRows, storeRows] = await Promise.all([
    merchantIds.length === 0
      ? Promise.resolve({ results: [] as MerchantRow[] })
      : db
          .prepare(
            `SELECT id, name, type FROM merchants WHERE id IN (${placeholders(merchantIds.length)})`,
          )
          .bind(...merchantIds)
          .all<MerchantRow>(),
    storeIds.length === 0
      ? Promise.resolve({ results: [] as StoreRow[] })
      : db
          .prepare(
            `SELECT id, merchant_id, name, type, province, city, district
               FROM stores WHERE id IN (${placeholders(storeIds.length)})`,
          )
          .bind(...storeIds)
          .all<StoreRow>(),
  ]);

  const merchantById = new Map(merchantRows.results.map((m) => [m.id, m]));
  const storeById = new Map(storeRows.results.map((s) => [s.id, s]));

  const itemsBySubOrder = new Map<string, OrderItemRow[]>();
  for (const item of itemRows.results) {
    const list = itemsBySubOrder.get(item.sub_order_id);
    if (list === undefined) itemsBySubOrder.set(item.sub_order_id, [item]);
    else list.push(item);
  }

  const tracesBySubOrder = new Map<string, OrderTraceRow[]>();
  for (const trace of traceRows.results) {
    if (trace.sub_order_id === null) continue;
    const list = tracesBySubOrder.get(trace.sub_order_id);
    if (list === undefined) tracesBySubOrder.set(trace.sub_order_id, [trace]);
    else list.push(trace);
  }

  return {
    order,
    subOrders: subOrders.map((subOrder) => ({
      subOrder,
      merchant: merchantById.get(subOrder.merchant_id) ?? null,
      store: storeById.get(subOrder.store_id) ?? null,
      items: itemsBySubOrder.get(subOrder.id) ?? [],
      // 只保留最近 10 条（SQL 已按时间升序，取尾部）
      traces: (tracesBySubOrder.get(subOrder.id) ?? []).slice(-EXPRESS_TRACE_LIMIT),
    })),
    aftersales: aftersaleRows.results,
  };
}

/**
 * 按 `created_at DESC, order_no DESC` 游标分页列出用户订单，并取齐列表项所需的子单/商品/售后聚合。
 *
 * 分页实现：多取 1 行判断 `hasMore`，命中则截断并用本页最后一行的
 * `(created_at, order_no)` 作为 `nextCursor`。
 */
export async function listOrders(db: D1Database, input: ListOrdersInput): Promise<OrderListResult> {
  const conditions: string[] = ["user_id = ?"];
  const args: unknown[] = [input.userId];

  if (input.statuses !== undefined && input.statuses.length > 0) {
    conditions.push(`status IN (${placeholders(input.statuses.length)})`);
    args.push(...input.statuses);
  }

  if (input.cursor !== undefined) {
    const cursor = decodeOrderCursor(input.cursor);
    if (cursor === null) throw new InvalidOrderCursorError(input.cursor);
    conditions.push("(created_at < ? OR (created_at = ? AND order_no < ?))");
    args.push(cursor.createdAt, cursor.createdAt, cursor.orderNo);
  }

  const orderRows = await db
    .prepare(
      `SELECT ${ORDER_COLUMNS} FROM orders
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, order_no DESC
        LIMIT ?`,
    )
    .bind(...args, input.limit + 1)
    .all<OrderRow>();

  const fetched = orderRows.results;
  const hasMore = fetched.length > input.limit;
  const page = hasMore ? fetched.slice(0, input.limit) : fetched;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeOrderCursor({ createdAt: last.created_at, orderNo: last.order_no })
      : null;

  if (page.length === 0) return { rows: [], nextCursor: null, hasMore: false };

  const orderIds = page.map((row) => row.id);
  const ph = placeholders(orderIds.length);

  const [subOrderRows, itemRows, aftersaleRows] = await Promise.all([
    db
      .prepare(`SELECT order_id, status FROM sub_orders WHERE order_id IN (${ph})`)
      .bind(...orderIds)
      .all<{ order_id: string; status: SubOrderStatus }>(),
    db
      .prepare(
        `SELECT ${ORDER_ITEM_COLUMNS} FROM order_items
          WHERE order_id IN (${ph})
          ORDER BY created_at ASC, id ASC`,
      )
      .bind(...orderIds)
      .all<OrderItemRow & { order_id: string }>(),
    db
      .prepare(
        `SELECT id, order_id, status, refund_amount FROM aftersales WHERE order_id IN (${ph})`,
      )
      .bind(...orderIds)
      .all<OrderAftersaleRow>(),
  ]);

  const statusesByOrder = new Map<string, SubOrderStatus[]>();
  for (const row of subOrderRows.results) {
    const list = statusesByOrder.get(row.order_id);
    if (list === undefined) statusesByOrder.set(row.order_id, [row.status]);
    else list.push(row.status);
  }

  const itemsByOrder = new Map<string, OrderItemRow[]>();
  for (const row of itemRows.results) {
    const list = itemsByOrder.get(row.order_id);
    if (list === undefined) itemsByOrder.set(row.order_id, [row]);
    else list.push(row);
  }

  const aftersalesByOrder = new Map<string, OrderAftersaleRow[]>();
  for (const row of aftersaleRows.results) {
    const list = aftersalesByOrder.get(row.order_id);
    if (list === undefined) aftersalesByOrder.set(row.order_id, [row]);
    else list.push(row);
  }

  return {
    rows: page.map((order) => {
      const statuses = statusesByOrder.get(order.id) ?? [];
      return {
        order,
        subOrderStatuses: statuses,
        subOrderCount: statuses.length,
        items: itemsByOrder.get(order.id) ?? [],
        aftersales: aftersalesByOrder.get(order.id) ?? [],
      };
    }),
    nextCursor,
    hasMore,
  };
}

/** 按 `phone_hash` 查 `users.id`；查不到返回 `null`（调用方回空列表，不 404）。 */
export async function findUserIdByPhoneHash(
  db: D1Database,
  phoneHash: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM users WHERE phone_hash = ? LIMIT 1")
    .bind(phoneHash)
    .first<{ id: string }>();
  return row?.id ?? null;
}
