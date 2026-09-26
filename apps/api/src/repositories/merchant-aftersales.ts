/**
 * 商户后台售后仓储（`/api/v1/merchant/aftersales`，`docs/06` §6 / `docs/08` §8.4）。
 *
 * ## 行级隔离（`docs/09` §9.2）
 *
 * `aftersales` 表**没有** `merchant_id` 列（`packages/db/src/schema/aftersale.ts`），
 * 归属通过 `sub_orders.merchant_id` 判定。故每个查询都 `JOIN sub_orders` 并
 * 在 SQL 层强制 `s.merchant_id IN (可见集合)`——**不读请求参数里的 merchantId**。
 *
 * ## 凭证不下发（`docs/07` §7.8.2 同口径）
 *
 * `evidence_urls` 只折算为 `evidenceCount` 数字，URL 原文不出本模块。
 */

import { evidenceCount } from "@dshop/services";
import type { AftersaleActor, AftersaleStatus, AftersaleType } from "@dshop/shared";

import type { MerchantScope } from "../middleware/merchant-scope.js";
import { merchantScopeClause } from "./merchant-scope-sql.js";

/* -------------------------------------------------------------------------- */
/* 行类型                                                                       */
/* -------------------------------------------------------------------------- */

/** 售后列表行（**不含** `evidence_urls`）。 */
export interface MerchantAftersaleListRow {
  readonly id: string;
  readonly aftersale_no: string;
  readonly order_no: string;
  readonly sub_order_no: string;
  readonly item_title: string;
  readonly quantity: number;
  readonly type: AftersaleType;
  readonly status: AftersaleStatus;
  readonly refund_amount: number;
  readonly created_at: string;
  readonly deadline_at: string | null;
}

/** 售后详情行（**不含** `evidence_urls`，仅额外取 `sku_id` / `reason` / 退货信息）。 */
export interface MerchantAftersaleDetailRow extends MerchantAftersaleListRow {
  readonly sku_id: string;
  readonly reason: string | null;
  readonly return_address: string | null;
  readonly return_express_company: string | null;
  readonly return_express_no: string | null;
}

/** `aftersale_logs` 行（timeline 唯一来源，`docs/08` §8.4）。 */
export interface MerchantAftersaleLogRow {
  readonly from_status: AftersaleStatus | null;
  readonly to_status: AftersaleStatus;
  readonly actor_type: AftersaleActor;
  readonly remark: string | null;
  readonly occurred_at: string;
}

/** `refunds` 行（`refund` 字段来源）。 */
export interface MerchantRefundRow {
  readonly refund_no: string;
  readonly channel: string | null;
  readonly status: string;
  readonly arrived_at: string | null;
  readonly estimated_arrival_days: number | null;
}

/** 详情聚合体。 */
export interface MerchantAftersaleAggregate {
  readonly aftersale: MerchantAftersaleDetailRow;
  readonly logs: readonly MerchantAftersaleLogRow[];
  /** 凭证数量（**绝不下发 URL**）。 */
  readonly evidenceCount: number;
  readonly refund: MerchantRefundRow | null;
}

/** `GET /merchant/aftersales` 的查询条件。 */
export interface ListMerchantAftersalesInput {
  readonly scope: MerchantScope;
  readonly status?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

/** 分页结果。 */
export interface MerchantAftersalePage {
  readonly rows: readonly MerchantAftersaleListRow[];
  readonly total: number;
}

/* -------------------------------------------------------------------------- */
/* SQL 片段                                                                     */
/* -------------------------------------------------------------------------- */

/** 列表 SELECT 的公共列（表别名：`a` = aftersales，`s` = sub_orders，`o` = orders）。 */
const AFTERSALE_LIST_COLUMNS =
  "a.id, a.aftersale_no, o.order_no, s.sub_order_no, a.item_title, a.quantity, a.type, a.status, a.refund_amount, a.created_at, a.deadline_at";

/** 详情额外列。 */
const AFTERSALE_DETAIL_COLUMNS = `${AFTERSALE_LIST_COLUMNS}, a.sku_id, a.reason, a.return_address, a.return_express_company, a.return_express_no`;

/** 归属 JOIN 与隔离条件（三张表的主键关联 + 商户隔离）。 */
const AFTERSALE_FROM =
  "FROM aftersales a JOIN sub_orders s ON s.id = a.sub_order_id JOIN orders o ON o.id = a.order_id";

/* -------------------------------------------------------------------------- */
/* 列表                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 按 `created_at DESC, aftersale_no DESC` 分页列出可见售后单。
 *
 * `total` 与 `list` 共用同一段 `WHERE`（含隔离条件），避免分页错位。
 */
export async function listMerchantAftersales(
  db: D1Database,
  input: ListMerchantAftersalesInput,
): Promise<MerchantAftersalePage> {
  const scopeClause = merchantScopeClause(input.scope, "s.merchant_id");
  const conditions: string[] = [scopeClause.clause];
  const args: unknown[] = [...scopeClause.args];

  if (input.status !== undefined) {
    conditions.push("a.status = ?");
    args.push(input.status);
  }
  const where = conditions.join(" AND ");
  const offset = (input.page - 1) * input.pageSize;

  const [countRow, rows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total ${AFTERSALE_FROM} WHERE ${where}`)
      .bind(...args)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT ${AFTERSALE_LIST_COLUMNS} ${AFTERSALE_FROM}
          WHERE ${where}
          ORDER BY a.created_at DESC, a.aftersale_no DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...args, input.pageSize, offset)
      .all<MerchantAftersaleListRow>(),
  ]);

  return { rows: rows.results, total: countRow?.total ?? 0 };
}

/* -------------------------------------------------------------------------- */
/* 详情                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 按售后单号取详情（**带行级隔离**）。
 *
 * 不属于当前商户的售后单与不存在的售后单**同样返回 `null`**，
 * 路由据此回 `ERR_MERCHANT_AFTERSALE_NOT_FOUND`（404 而非 403，防枚举）。
 */
export async function findMerchantAftersaleByNo(
  db: D1Database,
  scope: MerchantScope,
  aftersaleNo: string,
): Promise<MerchantAftersaleAggregate | null> {
  const scopeClause = merchantScopeClause(scope, "s.merchant_id");
  const aftersale = await db
    .prepare(
      `SELECT ${AFTERSALE_DETAIL_COLUMNS} ${AFTERSALE_FROM}
        WHERE a.aftersale_no = ? AND ${scopeClause.clause}
        LIMIT 1`,
    )
    .bind(aftersaleNo, ...scopeClause.args)
    .first<MerchantAftersaleDetailRow>();
  if (aftersale === null) return null;

  const [logRows, evidenceRow, refundRow] = await Promise.all([
    db
      .prepare(
        `SELECT from_status, to_status, actor_type, remark, occurred_at
           FROM aftersale_logs
          WHERE aftersale_id = ?
          ORDER BY occurred_at ASC, id ASC`,
      )
      .bind(aftersale.id)
      .all<MerchantAftersaleLogRow>(),
    // 只取凭证「数量」：URL 原文在本函数内被 evidenceCount() 折算掉，绝不随返回值外流
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
      .first<MerchantRefundRow>(),
  ]);

  return {
    aftersale,
    logs: logRows.results,
    evidenceCount: evidenceCount(evidenceRow?.evidence_urls),
    refund: refundRow,
  };
}
