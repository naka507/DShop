/**
 * 商户行级隔离的 **SQL 片段生成器**（`docs/09` §9.2 / `docs/06` §6）。
 *
 * ## 为什么要有这一层
 *
 * `docs/09` §9.2 的硬性要求是「商户数据行级隔离由 `merchantScope` 中间件强制注入
 * `merchant_id = 当前商户`，**不依赖前端传参**」。中间件只负责**解析**可见商户集合
 * （`resolveMerchantScope()`），真正把集合落成 `WHERE` 条件的动作在本文件——
 * 所有 merchant 业务查询都必须经过本函数拼接条件，**没有例外路径**。
 *
 * ## 三态语义（缺一不可）
 *
 * | 输入 | 生成条件 | 语义 |
 * | --- | --- | --- |
 * | `scope.all === true`（平台侧，`aud = admin`） | `1 = 1` | 可见全部商户（`docs/09` §9.2 平台侧读全部） |
 * | `merchantIds` 非空（商户侧） | `<column> IN (?, …)` | 仅可见自己所属商户 |
 * | `merchantIds` 为空（商户侧但未关联任何商户） | `1 = 0` | **恒空集**——绝不能退化成「不过滤」 |
 *
 * 第三态是本文件存在的核心理由：若把空集合写成「不加条件」，未关联商户的令牌就能读到
 * 全部数据，这是最典型的一类越权。
 */

import type { MerchantScope } from "../middleware/merchant-scope.js";

/** 一段可直接嵌入 SQL 的隔离条件。 */
export interface MerchantScopeClause {
  /** SQL 片段（不含 `AND` 前缀，调用方自行拼接）。 */
  readonly clause: string;
  /** 与 `?` 占位符一一对应的绑定值。 */
  readonly args: readonly string[];
}

/**
 * 生成商户隔离条件。
 *
 * @param scope  `resolveMerchantScope()` 解析出的可见范围
 * @param column 承载 `merchant_id` 的**限定列名**（如 `s.merchant_id`、`m.id`）——
 *               必须显式带表别名，避免多表 JOIN 时的列名歧义
 */
export function merchantScopeClause(scope: MerchantScope, column: string): MerchantScopeClause {
  // 平台侧：可见全部（`docs/09` §9.2）
  if (scope.all) return { clause: "1 = 1", args: [] };

  // 商户侧但未关联任何商户 → 恒空集（**不得**退化为「不过滤」）
  if (scope.merchantIds.length === 0) return { clause: "1 = 0", args: [] };

  return {
    clause: `${column} IN (${scope.merchantIds.map(() => "?").join(", ")})`,
    args: [...scope.merchantIds],
  };
}

/** 生成 `?, ?, …` 占位串（列表 IN 查询共用）。 */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** 生成 `LIMIT ? OFFSET ?` 的绑定值。 */
export function pageBounds(page: number, pageSize: number): { limit: number; offset: number } {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

/**
 * `LIKE` 关键词转义。
 *
 * 用户输入的 `%` / `_` / `\` 必须转义，否则 `q=%` 会退化成全表匹配。
 */
export function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/gu, (ch) => `\\${ch}`);
}
