/**
 * 营销域（4 表）：`coupon_templates`、`user_coupons`、`freight_templates`、`promotions`。
 *
 * 列名基准：`docs/M0-字段契约.md` §7。
 * 契约 §7 只给出 `user_coupons` 的索引（`idx_user_coupons_user` + `code` UNIQUE），
 * 其余三张表契约未列索引，故**不额外声明索引**，避免与手写 DDL 产生分歧。
 */

import type { UserCouponStatus } from "@dshop/shared";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** `coupon_templates` —— 优惠券模板。 */
export const couponTemplates = sqliteTable("coupon_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** `fixed` / `percent`。 */
  type: text("type").notNull(),
  discountAmount: integer("discount_amount").notNull().default(0),
  thresholdAmount: integer("threshold_amount").notNull().default(0),
  /** 万分比。 */
  discountBp: integer("discount_bp").notNull().default(0),
  totalQuantity: integer("total_quantity").notNull().default(0),
  issuedQuantity: integer("issued_quantity").notNull().default(0),
  perUserLimit: integer("per_user_limit").notNull().default(1),
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** `user_coupons` —— 用户券。 */
export const userCoupons = sqliteTable(
  "user_coupons",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    templateId: text("template_id").notNull(),
    code: text("code").notNull(),
    status: text("status").$type<UserCouponStatus>().notNull().default("unused"),
    usedAt: text("used_at"),
    orderId: text("order_id"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_user_coupons_code").on(t.code),
    index("idx_user_coupons_user").on(t.userId, t.status),
  ],
);

/** `freight_templates` —— 运费模板。 */
export const freightTemplates = sqliteTable("freight_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** `fixed` / `by_region` / `free_over`。 */
  type: text("type").notNull(),
  rules: text("rules").notNull().default("{}"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** `promotions` —— 满减/满赠活动。 */
export const promotions = sqliteTable("promotions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  rules: text("rules").notNull().default("{}"),
  startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(),
  status: text("status").notNull().default("draft"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
