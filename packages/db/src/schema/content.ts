/**
 * 内容域（3 表）：`reviews`、`content_blocks`、`cms_pages`。
 *
 * 列名基准：`docs/M0-字段契约.md` §8。
 * 契约 §8 只给出 `reviews` 的索引（`idx_reviews_spu`），其余两表不额外声明索引。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** `reviews` —— 商品评价。 */
export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    spuId: text("spu_id").notNull(),
    skuId: text("sku_id"),
    orderItemId: text("order_item_id"),
    rating: integer("rating").notNull().default(5),
    content: text("content"),
    images: text("images").notNull().default("[]"),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_reviews_spu").on(t.spuId, t.status)],
);

/** `content_blocks` —— 首页楼层/轮播/推荐位。 */
export const contentBlocks = sqliteTable("content_blocks", {
  id: text("id").primaryKey(),
  position: text("position").notNull(),
  title: text("title"),
  imageUrl: text("image_url"),
  linkUrl: text("link_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** `cms_pages` —— 静态页/协议。 */
export const cmsPages = sqliteTable(
  "cms_pages",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    content: text("content"),
    status: text("status").notNull().default("draft"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_cms_pages_slug").on(t.slug)],
);
