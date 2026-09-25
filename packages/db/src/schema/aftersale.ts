/**
 * 售后域（3 表）：`aftersales`★、`aftersale_logs`★、`aftersale_policies`★。
 *
 * 列名基准：`docs/M0-字段契约.md` §6。
 * 单号规则：`aftersale_no` `^AS\d{11}$`（8 位 UTC+8 `YYYYMMDD` + 3 位当日序列）。
 */

import type { AftersaleActor, AftersaleStatus, AftersaleType, PolicyCategory, PolicyStatus } from "@dshop/shared";
import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** `aftersales` —— 售后单。★ Agent `/aftersales/{no}` 的主表。 */
export const aftersales = sqliteTable(
  "aftersales",
  {
    id: text("id").primaryKey(),
    /** `^AS\d{11}$`。 */
    aftersaleNo: text("aftersale_no").notNull(),
    orderId: text("order_id").notNull(),
    subOrderId: text("sub_order_id").notNull(),
    userId: text("user_id").notNull(),
    skuId: text("sku_id").notNull(),
    /** 快照。 */
    itemTitle: text("item_title").notNull(),
    quantity: integer("quantity").notNull().default(1),
    type: text("type").$type<AftersaleType>().notNull(),
    /** 8 值枚举（简报 §3.7）。 */
    status: text("status").$type<AftersaleStatus>().notNull(),
    reason: text("reason"),
    /** **仅下发计数**。 */
    evidenceUrls: text("evidence_urls").notNull().default("[]"),
    refundAmount: integer("refund_amount").notNull().default(0),
    /** JSON；`WAIT_BUYER_RETURN` 起有值。 */
    returnAddress: text("return_address"),
    returnExpressCompany: text("return_express_company"),
    returnExpressNo: text("return_express_no"),
    deadlineAt: text("deadline_at"),
    appliedAt: text("applied_at"),
    refundedAt: text("refunded_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_aftersales_no").on(t.aftersaleNo),
    index("idx_aftersales_sub").on(t.subOrderId),
    index("idx_aftersales_user").on(t.userId, desc(t.createdAt)),
  ],
);

/** `aftersale_logs` —— 每次流转必须写此表，是 Agent `timeline` 的唯一来源。 */
export const aftersaleLogs = sqliteTable(
  "aftersale_logs",
  {
    id: text("id").primaryKey(),
    aftersaleId: text("aftersale_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    /** `buyer`/`merchant`/`platform`/`system`。 */
    actorType: text("actor_type").$type<AftersaleActor>().notNull(),
    actorId: text("actor_id"),
    remark: text("remark"),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_aftersale_logs_aftersale").on(t.aftersaleId, t.occurredAt)],
);

/** `aftersale_policies` —— 售后政策条款。★ Agent `/policies/{category}` 的唯一来源。 */
export const aftersalePolicies = sqliteTable(
  "aftersale_policies",
  {
    id: text("id").primaryKey(),
    category: text("category").$type<PolicyCategory>().notNull(),
    title: text("title").notNull(),
    /** markdown。 */
    content: text("content").notNull(),
    /** 如 `1.0.0`。 */
    version: text("version").notNull(),
    effectiveFrom: text("effective_from").notNull(),
    /** NULL = 长期有效。 */
    effectiveTo: text("effective_to"),
    status: text("status").$type<PolicyStatus>().notNull().default("draft"),
    tags: text("tags").notNull().default("[]"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_aftersale_policies_category").on(t.category, t.status, desc(t.effectiveFrom)),
  ],
);
