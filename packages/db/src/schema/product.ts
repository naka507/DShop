/**
 * 商品域（5 表）：`categories`、`products`★、`product_skus`★、`product_attrs`★、`product_images`。
 *
 * 列名基准：`docs/M0-字段契约.md` §4。
 * 可售库存 = `stock - locked_stock`（`docs/05` §5.3①）。
 */

import type { ProductStatus, SkuStatus } from "@dshop/shared";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** `categories` —— 类目树。 */
export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    /** NULL = 根。 */
    parentId: text("parent_id"),
    name: text("name").notNull(),
    slug: text("slug"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_categories_parent").on(t.parentId, t.sortOrder)],
);

/** `products` —— SPU（即 Agent 契约的 `spuId`）。★ `/specs`、`/stock` 的主表。 */
export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    categoryId: text("category_id").notNull(),
    /** 类目全路径名数组，如 `["数码","耳机","真无线耳机"]`。 */
    categoryPath: text("category_path").notNull().default("[]"),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    mainImage: text("main_image"),
    detailHtml: text("detail_html"),
    brand: text("brand"),
    status: text("status").$type<ProductStatus>().notNull().default("draft"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_products_merchant").on(t.merchantId, t.status),
    index("idx_products_category").on(t.categoryId, t.status),
  ],
);

/** `product_skus` —— SKU（即 `skuId`）。★ `/stock` 的库存来源。 */
export const productSkus = sqliteTable(
  "product_skus",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    /** `{"颜色":"曜石黑","版本":"降噪版"}`。 */
    spec: text("spec").notNull().default("{}"),
    skuCode: text("sku_code").notNull(),
    /** 分。 */
    price: integer("price").notNull(),
    /** 分（划线价）。 */
    marketPrice: integer("market_price"),
    /** 物理库存。 */
    stock: integer("stock").notNull().default(0),
    /** 已锁未付。 */
    lockedStock: integer("locked_stock").notNull().default(0),
    /** `YYYY-MM-DD`，**SKU 级**，可空。 */
    restockEta: text("restock_eta"),
    status: text("status").$type<SkuStatus>().notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_skus_product").on(t.productId, t.status),
    uniqueIndex("uq_skus_code").on(t.skuCode),
  ],
);

/** `product_attrs` —— SPU 级参数白皮书。★ PiEcho 规格语料的唯一来源。 */
export const productAttrs = sqliteTable(
  "product_attrs",
  {
    id: text("id").primaryKey(),
    spuId: text("spu_id").notNull(),
    /** 分组名（PiEcho 断言必须含「防护等级」）。 */
    groupName: text("group_name").notNull(),
    attrName: text("attr_name").notNull(),
    attrValue: text("attr_value").notNull(),
    unit: text("unit"),
    sortOrder: integer("sort_order").notNull().default(0),
    searchable: integer("searchable").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_product_attrs_spu").on(t.spuId, t.groupName, t.sortOrder)],
);

/** `product_images` —— 商品图集。 */
export const productImages = sqliteTable(
  "product_images",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    url: text("url").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_product_images_product").on(t.productId, t.sortOrder)],
);
