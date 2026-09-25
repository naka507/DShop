/**
 * D1 客户端工厂。
 *
 * 用法（`apps/api`）：
 * ```ts
 * const db = createDb(c.env.DB);
 * ```
 * 生产环境注意：D1 无交互式事务，多语句原子性用 `db.batch()`（`docs/05` §5.3②）。
 */

import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { schema } from "./schema/index.js";

/**
 * 由 Cloudflare D1 绑定创建 Drizzle 实例。
 *
 * @param d1 Workers 运行时注入的 `D1Database` 绑定。
 */
export function createDb(d1: D1Database): DrizzleD1Database<typeof schema> {
  return drizzle(d1, { schema });
}

/** 数据库实例类型（供 repository / service 层做参数标注）。 */
export type Db = DrizzleD1Database<typeof schema>;
