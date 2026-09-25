/**
 * 结算域（2 表）：`settlements`、`settlement_items`。
 *
 * 列名基准：`docs/M0-字段契约.md` §9。
 * 仅 `vendor` 商户参与；自营无结算流程（`docs/05` §5.4）。
 */

import type { SettlementStatus } from "@dshop/shared";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** `settlements` —— 结算单。 */
export const settlements = sqliteTable(
  "settlements",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    orderCount: integer("order_count").notNull().default(0),
    grossAmount: integer("gross_amount").notNull().default(0),
    commissionAmount: integer("commission_amount").notNull().default(0),
    netAmount: integer("net_amount").notNull().default(0),
    status: text("status").$type<SettlementStatus>().notNull().default("pending"),
    confirmedAt: text("confirmed_at"),
    paidAt: text("paid_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_settlements_merchant").on(t.merchantId, t.status)],
);

/** `settlement_items` —— 结算单 ↔ 子单明细。 */
export const settlementItems = sqliteTable("settlement_items", {
  id: text("id").primaryKey(),
  settlementId: text("settlement_id").notNull(),
  subOrderId: text("sub_order_id").notNull(),
  amount: integer("amount").notNull().default(0),
  commissionAmount: integer("commission_amount").notNull().default(0),
  createdAt: text("created_at").notNull(),
});
