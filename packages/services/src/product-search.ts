/**
 * S5 搜索升级缝（`docs/04` §4.3 S5、`docs/12` §12.9.3–§12.9.4、§12.15 P0-2）。
 *
 * ## 缝的形态
 *
 * | 绑定状态 | 实现 | 语义 |
 * | --- | --- | --- |
 * | `env.PRODUCT_SEARCH` **缺省** | {@link D1LikeProductSearch} | D1 `LIKE` + 简单分词，零配置、免费层可用。 |
 * | `env.PRODUCT_SEARCH` **存在** | {@link VectorizeProductSearch} | Cloudflare Vectorize 向量召回（付费组件，`docs/09` §9.x 明确免费层不可用）。 |
 *
 * **开关方式**：在 `apps/api/wrangler.jsonc` 增删 `vectorize` 绑定，代码零改动；
 * **删绑定即回滚**（`docs/12` §12.9.4 第 1 条）。接口不变，纯内部替换
 * （`docs/12` §12.9.3 S5「接口不变，纯内部替换」）。
 *
 * ## 为什么用结构化的最小接口而不是 `VectorizeIndex`
 *
 * `VectorizeIndex` 来自 `@cloudflare/workers-types`（仓库已装，版本见
 * `packages/services/tsconfig.json` 的 `types` 配置），本可直接引用。
 * 但**业务代码不得直接依赖 Cloudflare 类型**是升级缝纪律的核心，故：
 * - 工厂 {@link getProductSearch} 的入参按契约仍标注 `VectorizeIndex`（调用方传真实绑定）；
 * - 实现内部只依赖结构子集 {@link VectorizeLike}，便于测试注入假索引，
 *   也便于将来换外置搜索服务时不被 Cloudflare 类型绑死。
 */

import { PRODUCT_STATUS } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 接口                                                                        */
/* -------------------------------------------------------------------------- */

/** 检索入参（分页必填，`page` 从 1 起）。 */
export interface ProductSearchParams {
  /** 关键词；缺省表示「只按类目 / 全量浏览」。 */
  readonly q?: string;
  /** 类目 ID（`products.category_id`）。 */
  readonly categoryId?: string;
  /** 页码，从 `1` 起。 */
  readonly page: number;
  /** 每页条数。 */
  readonly pageSize: number;
}

/** 检索结果：**只返回 ID 与总数**，详情由调用方自行按 ID 取（避免缝里做 N+1 拼装）。 */
export interface ProductSearchResult {
  readonly ids: string[];
  readonly total: number;
}

/**
 * 商品检索端口——升级缝的**唯一抽象点**。
 *
 * 业务代码只依赖本接口，禁止直接 `import` Vectorize / 外置搜索 SDK。
 */
export interface ProductSearchPort {
  /** 检索商品 SPU ID 列表。 */
  search(params: ProductSearchParams): Promise<ProductSearchResult>;
}

/* -------------------------------------------------------------------------- */
/* 简单分词（默认实现与升级实现共用同一份入参规范化）                            */
/* -------------------------------------------------------------------------- */

/**
 * 简单分词（`docs/04` §4.3 S5「D1 `LIKE` + 简单分词」）。
 *
 * 规则（实现侧定案，`docs/04` 未定义具体分词算法）：
 * - 按空白与常见中英文标点切分；
 * - 丢弃长度 < 1 的空片段，去重，最多取 {@link MAX_TOKENS} 个词。
 *
 * ⚠️ 这是**朴素分词**，不做中文词典切分——一期搜索质量预期有限，
 * 这正是 S5 保留升级为 Vectorize 的原因。
 */
export const MAX_TOKENS = 8;

/** 分词分隔符：空白 + 常见中英文标点。 */
const TOKEN_SEPARATOR = /[\s,，、。;；:：!！?？"'“”‘’()（）[\]【】<>《》/\\|+\-*=~`@#$%^&]+/u;

/** 把查询串切成去重后的关键词数组。 */
export function tokenize(query: string | undefined): string[] {
  if (query === undefined) return [];
  const seen = new Set<string>();
  for (const raw of query.split(TOKEN_SEPARATOR)) {
    const token = raw.trim();
    if (token.length === 0) continue;
    seen.add(token);
    if (seen.size >= MAX_TOKENS) break;
  }
  return [...seen];
}

/**
 * 转义 `LIKE` 的通配符，避免用户输入的 `%` / `_` 变成通配（注入式放大结果集）。
 *
 * 配合 SQL 里的 `ESCAPE '\'` 使用。
 */
export function escapeLikePattern(token: string): string {
  return token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 默认实现的匹配列（`products` 表；列名基准 `packages/db/src/schema/product.ts`）。 */
const SEARCH_COLUMNS: readonly string[] = ["title", "subtitle", "brand"];

/* -------------------------------------------------------------------------- */
/* 默认实现：D1 LIKE + 简单分词                                                  */
/* -------------------------------------------------------------------------- */

/** `COUNT(*)` 结果行。 */
interface CountRow {
  readonly total: number;
}

/** ID 结果行。 */
interface IdRow {
  readonly id: string;
}

/**
 * 默认实现：D1 `LIKE` + 简单分词（`docs/04` §4.3 S5 默认形态）。
 *
 * 语义要点：
 * - 只检索**上架**商品（`status = 'onsale'`，`packages/shared` 的 `PRODUCT_STATUS`），
 *   下架 / 草稿商品不得出现在任何对外搜索结果里；
 * - 多个关键词之间是 **AND**（`LIKE` 条件全部满足），与「分词后收窄」的直觉一致；
 * - `total` 用独立 `COUNT(*)` 查询得到——**不是**当前页长度，否则调用方无法分页；
 * - 参数一律 `.bind()`，不做字符串拼接（SQL 注入防线，`docs/05` 的查询纪律）。
 */
export class D1LikeProductSearch implements ProductSearchPort {
  /** @param db `env.DB` 绑定（搜索是读路径；接入 S2 后可换成 `getReadDb(env)`）。 */
  public constructor(private readonly db: D1Database) {}

  /** 执行检索。 */
  public async search(params: ProductSearchParams): Promise<ProductSearchResult> {
    const page = normalizePage(params.page);
    const pageSize = normalizePageSize(params.pageSize);

    const where: string[] = ["status = ?"];
    const bindings: unknown[] = [PRODUCT_STATUS.ONSALE];

    if (params.categoryId !== undefined && params.categoryId.length > 0) {
      where.push("category_id = ?");
      bindings.push(params.categoryId);
    }

    for (const token of tokenize(params.q)) {
      const pattern = `%${escapeLikePattern(token)}%`;
      where.push(
        `(${SEARCH_COLUMNS.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
      );
      for (const _column of SEARCH_COLUMNS) bindings.push(pattern);
    }

    const whereSql = where.join(" AND ");

    const countRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM products WHERE ${whereSql}`)
      .bind(...bindings)
      .first<CountRow>();
    const total = countRow?.total ?? 0;

    const offset = (page - 1) * pageSize;
    const rows = await this.db
      .prepare(
        `SELECT id FROM products
          WHERE ${whereSql}
          ORDER BY updated_at DESC, id ASC
          LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, pageSize, offset)
      .all<IdRow>();

    return { ids: (rows.results ?? []).map((row) => row.id), total };
  }
}

/** 页码规范化：非正整数一律回落到第 1 页。 */
function normalizePage(page: number): number {
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/** 每页条数规范化：非正整数回落默认值，并设上限防止拖库。 */
function normalizePageSize(pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(pageSize, MAX_PAGE_SIZE);
}

/** 默认每页条数。 */
export const DEFAULT_PAGE_SIZE = 20;
/** 每页条数上限（防止一次拉全表）。 */
export const MAX_PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- */
/* 升级实现：Vectorize                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Vectorize 索引的**结构子集**（只用到 `query`）。
 *
 * 用结构类型而非 `VectorizeIndex`：接口窄、可在测试里注入假索引、
 * 将来换外置搜索服务时不被 Cloudflare 类型绑死（见文件头说明）。
 */
export interface VectorizeLike {
  query(
    vector: number[] | Float32Array | Float64Array,
    options?: { readonly topK?: number; readonly returnMetadata?: boolean | string },
  ): Promise<{ readonly matches: readonly { readonly id: string }[]; readonly count: number }>;
}

/**
 * 文本 → 向量 的嵌入函数。
 *
 * ⚠️ **诚实边界**：Vectorize **只接受向量**，不接受文本；把关键词变成向量
 * 需要嵌入模型（通常是 Workers AI 绑定）。`docs/04` §4.3 S5 只写了「换 Vectorize」，
 * **未定义嵌入来源**。因此本实现把嵌入函数作为**显式入参**注入，
 * 未注入时 `search` 直接抛错说明原因——绝不假装能用、也绝不静默返回空结果
 * （静默空结果会被误读成「没有匹配商品」）。
 */
export type EmbedQuery = (text: string) => Promise<number[]>;

/**
 * 升级实现：`env.PRODUCT_SEARCH.query(...)`（Cloudflare Vectorize）。
 *
 * 与默认实现的**语义对齐点**：`total` 取索引返回的 `count`，
 * `ids` 取匹配项 ID——调用方拿到的形状完全一致，切换不需要改任何路由。
 */
export class VectorizeProductSearch implements ProductSearchPort {
  /**
   * @param index Vectorize 索引绑定（`env.PRODUCT_SEARCH`）。
   * @param embed 文本嵌入函数（见 {@link EmbedQuery} 的诚实边界说明）。
   */
  public constructor(
    private readonly index: VectorizeLike,
    private readonly embed?: EmbedQuery,
  ) {}

  /** 向量召回。 */
  public async search(params: ProductSearchParams): Promise<ProductSearchResult> {
    const page = normalizePage(params.page);
    const pageSize = normalizePageSize(params.pageSize);

    const text = params.q ?? "";
    if (text.trim().length === 0) {
      // 无关键词时向量召回无意义（没有可嵌入的查询向量）；
      // 交由调用方走 D1 的类目浏览路径，这里返回空结果并保持 total 为 0。
      return { ids: [], total: 0 };
    }

    if (this.embed === undefined) {
      throw new Error(
        "VectorizeProductSearch 缺少嵌入函数：Vectorize 只接受向量，需要 Workers AI 等嵌入来源。" +
          "请在构造时注入 embed（见 docs/04 §4.3 S5 的未定义项说明）。",
      );
    }

    const vector = await this.embed(text);
    const matches = await this.index.query(vector, { topK: page * pageSize });

    const offset = (page - 1) * pageSize;
    const ids = matches.matches.slice(offset, offset + pageSize).map((match) => match.id);
    return { ids, total: matches.count };
  }
}

/* -------------------------------------------------------------------------- */
/* 绑定驱动的工厂                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 按**绑定存在性**选择实现（`docs/12` §12.9.4 第 1 条）。
 *
 * 检测写法固定为 `'PRODUCT_SEARCH' in env && env.PRODUCT_SEARCH`：`in` 兼容
 * 「键存在但值为 `undefined`」，真值判断兼容「键本身不存在」。
 */
export function getProductSearch(env: {
  DB: D1Database;
  PRODUCT_SEARCH?: VectorizeIndex;
}): ProductSearchPort {
  if ("PRODUCT_SEARCH" in env && env.PRODUCT_SEARCH) {
    return new VectorizeProductSearch(env.PRODUCT_SEARCH);
  }
  return new D1LikeProductSearch(env.DB);
}
