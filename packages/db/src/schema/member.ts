/**
 * 会员域（3 表）：`users`★、`user_addresses`、`user_favorites`。
 *
 * 列名基准：`docs/M0-字段契约.md` §1（逐列照录，不增删列名）。
 * 全局约定见契约 §0：主键 `id TEXT PRIMARY KEY`（ULID 26 位）、时间列 TEXT ISO-8601 UTC、
 * 布尔列 INTEGER `0`/`1`、**不声明 SQL 级 FOREIGN KEY**。
 */

import type { UserStatus } from "@dshop/shared";
import { desc } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** `users` —— 会员主表。★ Agent `/orders?phone=` 的查询入口（`phone_hash` 等值比对）。 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** 加密存储（AES-GCM，密钥 `PHONE_ENC_KEY`）。 */
    phone: text("phone").notNull(),
    /** `HMAC-SHA256(PHONE_HASH_PEPPER, 规范化11位)`，供等值查询。 */
    phoneHash: text("phone_hash").notNull(),
    nickname: text("nickname"),
    avatarUrl: text("avatar_url"),
    /** ⚠️ 文档未定义取值，见 `enums.ts` `USER_STATUS`。 */
    status: text("status").$type<UserStatus>().notNull().default("active"),
    wechatOpenid: text("wechat_openid"),
    wechatUnionid: text("wechat_unionid"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_users_phone").on(t.phone),
    uniqueIndex("uq_users_phone_hash").on(t.phoneHash),
  ],
);

/** `user_addresses` —— 收货地址。 */
export const userAddresses = sqliteTable(
  "user_addresses",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    receiverName: text("receiver_name").notNull(),
    /** 加密存储（同 `users.phone`）。 */
    receiverPhone: text("receiver_phone").notNull(),
    province: text("province").notNull(),
    city: text("city").notNull(),
    district: text("district").notNull(),
    detail: text("detail").notNull(),
    postalCode: text("postal_code"),
    isDefault: integer("is_default").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_user_addresses_user").on(t.userId, desc(t.isDefault))],
);

/** `user_favorites` —— 商品收藏。 */
export const userFavorites = sqliteTable(
  "user_favorites",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    spuId: text("spu_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_user_favorites").on(t.userId, t.spuId)],
);
