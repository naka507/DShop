/**
 * 41 表 Drizzle schema 汇总导出。
 *
 * 列名基准：`docs/M0-字段契约.md`（§1–§10，41 表逐列照录）。
 * 手写 DDL 与本节逐列一致：`migrations/0001_init.sql`。
 *
 * 域分组（41）：
 * - 会员 3：`users`、`user_addresses`、`user_favorites`
 * - 账号 7：`admin_users`、`roles`、`admin_user_roles`、`merchant_members`、`refresh_tokens`、`service_tokens`、`audit_logs`
 * - 商户 3：`merchants`、`stores`、`store_stocks`
 * - 商品 5：`categories`、`products`、`product_skus`、`product_attrs`、`product_images`
 * - 交易 8：`cart_items`、`orders`、`sub_orders`、`order_items`、`order_status_logs`、`payments`、`refunds`、`idempotency_keys`
 * - 售后 3：`aftersales`、`aftersale_logs`、`aftersale_policies`
 * - 营销 4：`coupon_templates`、`user_coupons`、`freight_templates`、`promotions`
 * - 内容 3：`reviews`、`content_blocks`、`cms_pages`
 * - 结算 2：`settlements`、`settlement_items`
 * - 支撑 3：`task_queue`、`settings`、`agent_call_logs`
 */

export * from "./account.js";
export * from "./aftersale.js";
export * from "./content.js";
export * from "./marketing.js";
export * from "./member.js";
export * from "./merchant.js";
export * from "./product.js";
export * from "./settlement.js";
export * from "./support.js";
export * from "./trade.js";

import * as account from "./account.js";
import * as aftersale from "./aftersale.js";
import * as content from "./content.js";
import * as marketing from "./marketing.js";
import * as member from "./member.js";
import * as merchant from "./merchant.js";
import * as product from "./product.js";
import * as settlement from "./settlement.js";
import * as support from "./support.js";
import * as trade from "./trade.js";

/**
 * 全部 41 张表（`drizzle(d1, { schema })` 用；也供测试断言表数量）。
 *
 * 命名空间展平为单一对象，避免 `import * as` 的域前缀污染查询 API。
 */
export const schema = {
  ...member,
  ...account,
  ...merchant,
  ...product,
  ...trade,
  ...aftersale,
  ...marketing,
  ...content,
  ...settlement,
  ...support,
};
