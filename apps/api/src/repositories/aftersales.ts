/**
 * 售后仓储（Agent 只读契约 `docs/07` §7.6 / §7.7）。
 *
 * 设计约束同 `orders.ts`：原生 D1 API、显式列名、无 `SELECT *`。
 *
 * ⚠️ **`evidence_urls` 绝不下发**（凭证图可能含隐私，`docs/07` §7.8.2）——
 * 本层在**独立的计数专用查询**里取出该列，立即用 `@dshop/services` 的
 * `evidenceCount()` 折算为数字，**URL 原文不出本函数**（返回类型里没有该字段）。
 */

import { evidenceCount } from "@dshop/services";
import type { AftersaleActor, AftersaleStatus, AftersaleType, PolicyCategory } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 行类型                                                                       */
/* -------------------------------------------------------------------------- */

/** `aftersales` 行（**不含** `evidence_urls`）。 */
export interface AftersaleRow {
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
  /** JSON；`WAIT_BUYER_RETURN` 起有值。 */
  readonly return_address: string | null;
  readonly return_express_company: string | null;
  readonly return_express_no: string | null;
  readonly deadline_at: string | null;
  readonly refunded_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** `aftersale_logs` 行（timeline 唯一来源）。 */
export interface AftersaleLogRow {
  readonly from_status: AftersaleStatus | null;
  readonly to_status: AftersaleStatus;
  readonly actor_type: AftersaleActor;
  readonly remark: string | null;
  readonly occurred_at: string;
}

/** `refunds` 行（`refund` 字段来源）。 */
export interface RefundRow {
  readonly refund_no: string;
  readonly channel: string | null;
  readonly status: string;
  readonly arrived_at: string | null;
  readonly estimated_arrival_days: number | null;
}

/** `aftersale_policies` 行。 */
export interface PolicyRow {
  readonly id: string;
  readonly category: PolicyCategory;
  readonly title: string;
  readonly content: string;
  readonly version: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly updated_at: string;
  readonly tags: string;
}

/** `/aftersales/{aftersaleNo}` 的取数结果。 */
export interface AftersaleAggregate {
  readonly aftersale: AftersaleRow;
  readonly logs: readonly AftersaleLogRow[];
  /** 凭证数量（**绝不下发 URL**）。 */
  readonly evidenceCount: number;
  readonly refund: RefundRow | null;
  /** 主单号（`orders.order_no`，由 `order_id` 关联取出）。 */
  readonly orderNo: string;
  /** 子单号（`sub_orders.sub_order_no`，由 `sub_order_id` 关联取出）。 */
  readonly subOrderNo: string;
  /** 关联政策摘要（按 `type` 推导分类后取最新生效版）；无则 `null`。 */
  readonly policy: PolicyRow | null;
}

/* -------------------------------------------------------------------------- */
/* SQL 片段                                                                     */
/* -------------------------------------------------------------------------- */

const AFTERSALE_COLUMNS =
  "id, aftersale_no, order_id, sub_order_id, sku_id, item_title, quantity, type, status, reason, refund_amount, return_address, return_express_company, return_express_no, deadline_at, refunded_at, created_at, updated_at";

const POLICY_COLUMNS =
  "id, category, title, content, version, effective_from, effective_to, updated_at, tags";

/**
 * 售后类型 → 政策分类（用于 `policy` 摘要）。
 *
 * ⚠️ **文档未定义**：`docs/07` §7.6 的 `policy.category` 示例为 `"return"`，
 * 但未给出由 `type` 推导分类的规则。实现侧定案：
 * `return_refund` → `return`，`refund_only` → `refund`。
 */
export const AFTERSALE_TYPE_POLICY_CATEGORY: Record<AftersaleType, PolicyCategory> = {
  return_refund: "return",
  refund_only: "refund",
};

/* -------------------------------------------------------------------------- */
/* 取数                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 按售后单号取齐：`aftersales` + `aftersale_logs`（按 `occurred_at ASC`）
 * + 凭证计数 + `refunds` + 关联政策摘要。查不到返回 `null`（路由回 `40403`）。
 */
export async function findAftersaleByNo(
  db: D1Database,
  aftersaleNo: string,
  nowMs: number = Date.now(),
): Promise<AftersaleAggregate | null> {
  const aftersale = await db
    .prepare(`SELECT ${AFTERSALE_COLUMNS} FROM aftersales WHERE aftersale_no = ? LIMIT 1`)
    .bind(aftersaleNo)
    .first<AftersaleRow>();
  if (aftersale === null) return null;

  const [logRows, evidenceRow, refundRow, orderRow, subOrderRow] = await Promise.all([
    db
      .prepare(
        `SELECT from_status, to_status, actor_type, remark, occurred_at
           FROM aftersale_logs
          WHERE aftersale_id = ?
          ORDER BY occurred_at ASC, id ASC`,
      )
      .bind(aftersale.id)
      .all<AftersaleLogRow>(),
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
      .first<RefundRow>(),
    db
      .prepare("SELECT order_no FROM orders WHERE id = ? LIMIT 1")
      .bind(aftersale.order_id)
      .first<{ order_no: string }>(),
    db
      .prepare("SELECT sub_order_no FROM sub_orders WHERE id = ? LIMIT 1")
      .bind(aftersale.sub_order_id)
      .first<{ sub_order_no: string }>(),
  ]);

  const policyCategory = AFTERSALE_TYPE_POLICY_CATEGORY[aftersale.type];
  const policies = await findPoliciesByCategory(db, policyCategory, nowMs);

  return {
    aftersale,
    orderNo: orderRow?.order_no ?? aftersale.aftersale_no,
    subOrderNo: subOrderRow?.sub_order_no ?? aftersale.sub_order_id,
    logs: logRows.results,
    evidenceCount: evidenceCount(evidenceRow?.evidence_urls),
    refund: refundRow,
    policy: policies[0] ?? null,
  };
}

/**
 * 取某分类下**当前生效**的政策条款，按 `effective_from DESC`。
 *
 * 生效判据：`status = 'effective'` 且 `effective_from <= now` 且
 * （`effective_to IS NULL` 或 `effective_to > now`）。
 *
 * `category = 'all'` 时返回全部分类的生效条款（`docs/07` §7.6 的聚合查询值）。
 *
 * @param nowMs 当前时刻（毫秒）；注入便于测试。
 */
export async function findPoliciesByCategory(
  db: D1Database,
  category: string,
  nowMs: number = Date.now(),
): Promise<PolicyRow[]> {
  const nowIso = new Date(nowMs).toISOString();
  const base = `SELECT ${POLICY_COLUMNS} FROM aftersale_policies
                 WHERE status = 'effective'
                   AND effective_from <= ?
                   AND (effective_to IS NULL OR effective_to > ?)`;

  const statement =
    category === "all"
      ? db.prepare(`${base} ORDER BY category ASC, effective_from DESC`).bind(nowIso, nowIso)
      : db
          .prepare(`${base} AND category = ? ORDER BY effective_from DESC`)
          .bind(nowIso, nowIso, category);

  const rows = await statement.all<PolicyRow>();
  return rows.results;
}
