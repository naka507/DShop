/**
 * C 端售后仓储（`docs/06` §6 的 `/api/v1/shop/aftersales*`，`docs/08` §8.4）。
 *
 * 表：`aftersales`、`aftersale_logs`、`refunds`。
 *
 * ⚠️ 与 Agent 面共用同一批表，但口径不同：
 * - C 端是**归属方本人**，`return_address`（回寄地址）**原样下发**（不脱敏）
 * - `evidence_urls` 与 Agent 面一致，**只下发计数**（`ShopAftersaleDetailSchema` 的 `evidenceCount`）
 *
 * ⚠️ 时间线（`timeline`）的唯一来源是 `aftersale_logs`——**每次流转都必须写**，
 * 否则用户看不到「我的退货到哪一步了」（`docs/08` §8.4）。
 */

import { evidenceCount } from "@dshop/services";
import type { AftersaleActor, AftersaleStatus, AftersaleType } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 行类型                                                                       */
/* -------------------------------------------------------------------------- */

/** `aftersales` 行（**不含** `evidence_urls`——只在计数专用查询里取）。 */
export interface ShopAftersaleRow {
  readonly id: string;
  readonly aftersale_no: string;
  readonly order_id: string;
  readonly sub_order_id: string;
  readonly sku_id: string;
  readonly item_title: string;
  readonly quantity: number;
  readonly type: AftersaleType;
  readonly status: AftersaleStatus;
  readonly reason: string | null;
  readonly refund_amount: number;
  readonly return_address: string | null;
  readonly return_express_company: string | null;
  readonly return_express_no: string | null;
  readonly deadline_at: string | null;
  readonly created_at: string;
}

/** `aftersale_logs` 行。 */
export interface ShopAftersaleLogRow {
  readonly from_status: AftersaleStatus | null;
  readonly to_status: AftersaleStatus;
  readonly actor_type: AftersaleActor;
  readonly remark: string | null;
  readonly occurred_at: string;
}

/** `refunds` 行（`refund` 字段来源）。 */
export interface ShopRefundRow {
  readonly refund_no: string;
  readonly channel: string | null;
  readonly status: string;
  readonly arrived_at: string | null;
  readonly estimated_arrival_days: number | null;
}

/** 售后详情聚合体。 */
export interface ShopAftersaleDetailAggregate {
  readonly aftersale: ShopAftersaleRow;
  readonly logs: readonly ShopAftersaleLogRow[];
  readonly evidenceCount: number;
  readonly refund: ShopRefundRow | null;
  readonly orderNo: string;
  readonly subOrderNo: string;
}

/** 售后列表项聚合体。 */
export interface ShopAftersaleListRow {
  readonly id: string;
  readonly aftersale_no: string;
  readonly order_no: string | null;
  readonly type: AftersaleType;
  readonly status: AftersaleStatus;
  readonly item_title: string;
  readonly refund_amount: number;
  readonly created_at: string;
}

/** 售后列表结果。 */
export interface ShopAftersaleListResult {
  readonly rows: readonly ShopAftersaleListRow[];
  readonly total: number;
}

/* -------------------------------------------------------------------------- */
/* SQL 片段                                                                     */
/* -------------------------------------------------------------------------- */

const AFTERSALE_COLUMNS =
  "id, aftersale_no, order_id, sub_order_id, sku_id, item_title, quantity, type, " +
  "status, reason, refund_amount, return_address, return_express_company, " +
  "return_express_no, deadline_at, created_at";

/* -------------------------------------------------------------------------- */
/* 取数                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 按售后单号取详情聚合体（带**归属校验**：`user_id` 不匹配即视为不存在）。
 *
 * 查不到返回 `null`，路由回 `ERR_SHOP_AFTERSALE_NOT_FOUND`——不区分「不存在」
 * 与「不属于你」，防枚举（`SHOP_ERROR_CODES.AFTERSALE_NOT_FOUND` 的语义注释）。
 */
export async function findShopAftersaleByNo(
  db: D1Database,
  userId: string,
  aftersaleNo: string,
): Promise<ShopAftersaleDetailAggregate | null> {
  const aftersale = await db
    .prepare(
      `SELECT ${AFTERSALE_COLUMNS} FROM aftersales
        WHERE aftersale_no = ? AND user_id = ?
        LIMIT 1`,
    )
    .bind(aftersaleNo, userId)
    .first<ShopAftersaleRow>();
  if (aftersale === null) return null;

  const [logRes, evidenceRow, refundRow, orderRow, subOrderRow] = await Promise.all([
    db
      .prepare(
        `SELECT from_status, to_status, actor_type, remark, occurred_at
           FROM aftersale_logs
          WHERE aftersale_id = ?
          ORDER BY occurred_at ASC, id ASC`,
      )
      .bind(aftersale.id)
      .all<ShopAftersaleLogRow>(),
    // 只取凭证「数量」：URL 原文在本函数内被 evidenceCount() 折算掉，绝不外流
    db
      .prepare("SELECT evidence_urls FROM aftersales WHERE id = ? LIMIT 1")
      .bind(aftersale.id)
      .first<{ evidence_urls: string }>(),
    db
      .prepare(
        `SELECT refund_no, channel, status, arrived_at, estimated_arrival_days
           FROM refunds WHERE aftersale_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(aftersale.id)
      .first<ShopRefundRow>(),
    db
      .prepare("SELECT order_no FROM orders WHERE id = ? LIMIT 1")
      .bind(aftersale.order_id)
      .first<{ order_no: string }>(),
    db
      .prepare("SELECT sub_order_no FROM sub_orders WHERE id = ? LIMIT 1")
      .bind(aftersale.sub_order_id)
      .first<{ sub_order_no: string }>(),
  ]);

  return {
    aftersale,
    orderNo: orderRow?.order_no ?? aftersale.aftersale_no,
    subOrderNo: subOrderRow?.sub_order_no ?? aftersale.sub_order_id,
    logs: logRes.results,
    evidenceCount: evidenceCount(evidenceRow?.evidence_urls),
    refund: refundRow,
  };
}

/**
 * 分页列出该用户的售后单（后台组统一分页 `{ page, pageSize, total, list }`）。
 *
 * 列表项需要 `orderNo`，故 `JOIN orders`——`aftersales.order_id` 是 ULID 主键，
 * 而契约下发的 `orderNo` 是 `DS…` 单号（`docs/05` §5.3⑤）。
 */
export async function listShopAftersales(
  db: D1Database,
  input: {
    readonly userId: string;
    readonly status?: AftersaleStatus | undefined;
    readonly page: number;
    readonly pageSize: number;
  },
): Promise<ShopAftersaleListResult> {
  const conditions: string[] = ["a.user_id = ?"];
  const args: unknown[] = [input.userId];
  if (input.status !== undefined) {
    conditions.push("a.status = ?");
    args.push(input.status);
  }
  const where = conditions.join(" AND ");
  const offset = (input.page - 1) * input.pageSize;

  const [rowRes, countRes] = await Promise.all([
    db
      .prepare(
        `SELECT a.id AS id, a.aftersale_no AS aftersale_no, o.order_no AS order_no,
                a.type AS type, a.status AS status, a.item_title AS item_title,
                a.refund_amount AS refund_amount, a.created_at AS created_at
           FROM aftersales a
           LEFT JOIN orders o ON o.id = a.order_id
          WHERE ${where}
          ORDER BY a.created_at DESC, a.aftersale_no DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...args, input.pageSize, offset)
      .all<ShopAftersaleListRow>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM aftersales a WHERE ${where}`)
      .bind(...args)
      .first<{ total: number }>(),
  ]);

  return { rows: rowRes.results, total: countRes?.total ?? 0 };
}

/**
 * 校验申请售后的商品是否属于该用户的某子单（并取回下单快照的标题与单价）。
 *
 * 归属链路：`orders.user_id` → `sub_orders.order_no` → `order_items.sku_id`。
 * 全部在一条 SQL 里判定，**不信任**请求体里的任何归属字段。
 */
export async function findAftersaleApplyTarget(
  db: D1Database,
  input: {
    readonly userId: string;
    readonly orderNo: string;
    readonly subOrderNo: string;
    readonly skuId: string;
  },
): Promise<{
  readonly orderId: string;
  readonly subOrderId: string;
  readonly title: string;
  readonly unitPrice: number;
  readonly quantity: number;
  readonly subOrderStatus: string;
} | null> {
  const row = await db
    .prepare(
      `SELECT o.id AS order_id, s.id AS sub_order_id, s.status AS sub_order_status,
              i.title AS title, i.unit_price AS unit_price, i.quantity AS quantity
         FROM orders o
         JOIN sub_orders s ON s.order_id = o.id AND s.sub_order_no = ?
         JOIN order_items i ON i.sub_order_id = s.id AND i.sku_id = ?
        WHERE o.order_no = ? AND o.user_id = ?
        LIMIT 1`,
    )
    .bind(input.subOrderNo, input.skuId, input.orderNo, input.userId)
    .first<{
      order_id: string;
      sub_order_id: string;
      sub_order_status: string;
      title: string;
      unit_price: number;
      quantity: number;
    }>();

  if (row === null) return null;
  return {
    orderId: row.order_id,
    subOrderId: row.sub_order_id,
    title: row.title,
    unitPrice: row.unit_price,
    quantity: row.quantity,
    subOrderStatus: row.sub_order_status,
  };
}

/* -------------------------------------------------------------------------- */
/* 写入                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 写入售后单 + 首条时间线日志（`DB.batch()` 原子）。
 *
 * `status` 初始恒为 `PENDING_MERCHANT`（`docs/08` §8.4 的流程起点）；
 * 首条日志 `from = null, to = PENDING_MERCHANT, actor = buyer`。
 */
export async function insertShopAftersale(
  db: D1Database,
  input: {
    readonly id: string;
    readonly aftersaleNo: string;
    readonly orderId: string;
    readonly subOrderId: string;
    readonly userId: string;
    readonly skuId: string;
    readonly itemTitle: string;
    readonly quantity: number;
    readonly type: AftersaleType;
    readonly reason: string;
    readonly evidenceUrls: string;
    readonly refundAmount: number;
    readonly nowIso: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO aftersales
           (id, aftersale_no, order_id, sub_order_id, user_id, sku_id, item_title,
            quantity, type, status, reason, evidence_urls, refund_amount,
            return_address, return_express_company, return_express_no,
            deadline_at, applied_at, refunded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_MERCHANT', ?, ?, ?,
                 NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
      )
      .bind(
        input.id,
        input.aftersaleNo,
        input.orderId,
        input.subOrderId,
        input.userId,
        input.skuId,
        input.itemTitle,
        input.quantity,
        input.type,
        input.reason,
        input.evidenceUrls,
        input.refundAmount,
        input.nowIso,
        input.nowIso,
        input.nowIso,
      ),
    db
      .prepare(
        `INSERT INTO aftersale_logs
           (id, aftersale_id, from_status, to_status, actor_type, actor_id, remark,
            occurred_at, created_at)
         VALUES (?, ?, NULL, 'PENDING_MERCHANT', 'buyer', ?, NULL, ?, ?)`,
      )
      .bind(`${input.id}-L0`, input.id, input.userId, input.nowIso, input.nowIso),
  ]);
}
