/**
 * 商户域（3 表）：`merchants`、`stores`★、`store_stocks`。
 *
 * 列名基准：`docs/M0-字段契约.md` §3。
 * `store_stocks` 二期按需启用，一期留空（`docs/05` §5.4）。
 */

import type { MerchantStatus, MerchantType, StoreType } from "@dshop/shared";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** `merchants` —— 商户。`self`=自营、`vendor`=入驻、`branch`=分店。 */
export const merchants = sqliteTable(
  "merchants",
  {
    id: text("id").primaryKey(),
    type: text("type").$type<MerchantType>().notNull(),
    name: text("name").notNull(),
    logoUrl: text("logo_url"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    qualificationUrls: text("qualification_urls").notNull().default("[]"),
    status: text("status").$type<MerchantStatus>().notNull().default("pending"),
    /** 万分比。自营恒为 0。 */
    commissionRateBp: integer("commission_rate_bp").notNull().default(0),
    settlementAccount: text("settlement_account").notNull().default("{}"),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_merchants_status").on(t.status)],
);

/** `stores` —— 履约节点。★ Agent `/products/{spuId}/stock` 的 `shipFrom` 来源。 */
export const stores = sqliteTable(
  "stores",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    name: text("name").notNull(),
    type: text("type").$type<StoreType>().notNull(),
    longitude: real("longitude"),
    latitude: real("latitude"),
    province: text("province"),
    city: text("city"),
    district: text("district"),
    address: text("address"),
    businessHours: text("business_hours").notNull().default("{}"),
    supportsPickup: integer("supports_pickup").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_stores_merchant").on(t.merchantId, t.status)],
);

/** `store_stocks` —— 门店级独立库存（二期）。 */
export const storeStocks = sqliteTable(
  "store_stocks",
  {
    id: text("id").primaryKey(),
    storeId: text("store_id").notNull(),
    skuId: text("sku_id").notNull(),
    stock: integer("stock").notNull().default(0),
    lockedStock: integer("locked_stock").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_store_stocks").on(t.storeId, t.skuId)],
);
