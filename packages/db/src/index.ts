/**
 * `@dshop/db` —— D1 数据层。
 *
 * - `./schema` 41 表 Drizzle schema（列名基准 `docs/M0-字段契约.md`）
 * - `./client` D1 → Drizzle 实例工厂
 */

export * from "./client.js";
export * from "./schema/index.js";
