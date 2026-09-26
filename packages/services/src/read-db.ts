/**
 * S2 数据库读扩展升级缝（`docs/04` §4.3 S2、`docs/12` §12.9.3–§12.9.4）。
 *
 * ## 缝的形态
 *
 * | 绑定状态 | 实现 | 语义 |
 * | --- | --- | --- |
 * | `env.READ_DB` **缺省** | 直接用主库 `env.DB` | 单库直连（+ Cache API 边缘缓存），零配置、免费层可用。 |
 * | `env.READ_DB` **存在** | 读路径走只读副本 | **升级目标 = D1 只读副本（Sessions API）**，跨区就近读，降低主库读延迟。 |
 *
 * **开关方式**：在 `apps/api/wrangler.jsonc` 的 `d1_databases` 增删 binding 为
 * `READ_DB` 的条目，代码零改动；**删绑定即回滚**（`docs/12` §12.9.4 第 1 条）。
 *
 * ## 只读纪律
 *
 * 副本**只用于读路径**。写路径（下单、扣库存、审计落库……）**必须**继续用 `env.DB`，
 * 否则会写到副本上导致数据分叉。因此本模块只提供「读连接」入口，
 * 写连接请继续直接用 `env.DB`（或后续的写库工厂）。
 *
 * ⚠️ `docs/04` §4.3 S2 的「开关方式」列写的是「services 读连接加 `withSession` 配置」，
 * 那是 D1 Sessions API（`withSession("first-primary")` / `"first-unconstrained"`）的用法；
 * 本模块只做**连接选择**（绑定存在性驱动），Sessions 配置在真正接入副本时叠加，
 * 不改变本接口签名。
 */

import { createDb } from "@dshop/db";
import type { Db } from "@dshop/db";

/**
 * 取读路径的 D1 连接。
 *
 * 检测写法固定为 `'READ_DB' in env && env.READ_DB`：`in` 处理「键存在但值为 `undefined`」，
 * 真值判断处理「键本身不存在」（本地开发 / 单元测试的裸对象）。两种缺省形态都回退主库。
 */
export function getReadDb(env: { DB: D1Database; READ_DB?: D1Database }): D1Database {
  if ("READ_DB" in env && env.READ_DB) return env.READ_DB;
  return env.DB;
}

/**
 * 取读路径的 Drizzle 实例（复用 `packages/db` 的 `createDb` 工厂，`docs/05` §5.3②）。
 *
 * 与 `apps/api` 里直接 `createDb(env.DB)` 的写法相比，本函数**只改连接来源**，
 * 不引入任何新的查询语义——这样「加/删绑定」不需要动任何 repository。
 */
export function getReadDrizzle(env: { DB: D1Database; READ_DB?: D1Database }): Db {
  return createDb(getReadDb(env));
}
