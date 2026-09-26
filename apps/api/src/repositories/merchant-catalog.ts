/**
 * 商户后台商品 / 类目 / 商户 / 门店仓储（`/api/v1/merchant/{products,categories,merchants,stores}`）。
 *
 * ## 行级隔离（`docs/09` §9.2）
 *
 * - `products` / `stores` / `merchants` 三张表**都有** `merchant_id` 列
 *   （`merchants` 的隔离列是自身的 `id`），故隔离条件直接落在这三列上。
 * - `categories` 是**平台级共享字典**（`packages/db/src/schema/product.ts` 的
 *   `categories` 表无 `merchant_id`），故 `MERCHANT_ENDPOINTS.CATEGORIES` 的
 *   `merchantScoped` 为 `false`——本层**不做**商户过滤，但也不暴露任何商户私有数据。
 *
 * 所有隔离条件的绑定值来自 `resolveMerchantScope()`，**不读请求参数里的 merchantId**。
 */

import type { MerchantStatus, MerchantType, SkuStatus } from "@dshop/shared";

import type { MerchantScope } from "../middleware/merchant-scope.js";
import { escapeLike, merchantScopeClause, placeholders } from "./merchant-scope-sql.js";

/* -------------------------------------------------------------------------- */
/* 行类型                                                                       */
/* -------------------------------------------------------------------------- */

/** `products` 行 + 由 `product_skus` 聚合出的价格区间。 */
export interface MerchantProductRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly merchant_id: string;
  readonly category_id: string;
  readonly status: string;
  readonly main_image: string | null;
  readonly updated_at: string;
  /** 最低价（分）；无 SKU 时为 `0`。 */
  readonly min_price: number;
  /** 最高价（分）；无 SKU 时为 `0`。 */
  readonly max_price: number;
}

/** `product_skus` 行（详情用，可售库存 = `stock - locked_stock`）。 */
export interface MerchantSkuRow {
  readonly id: string;
  readonly product_id: string;
  readonly sku_code: string;
  readonly spec: string;
  readonly price: number;
  readonly stock: number;
  readonly locked_stock: number;
  readonly status: SkuStatus;
}

/** `categories` 行。 */
export interface MerchantCategoryRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly sort_order: number;
  readonly status: string;
}

/** `merchants` 行。 */
export interface MerchantMerchantRow {
  readonly id: string;
  readonly name: string;
  readonly type: MerchantType;
  readonly status: MerchantStatus;
  readonly contact_name: string | null;
  readonly contact_phone: string | null;
  readonly created_at: string;
}

/** `stores` 行。 */
export interface MerchantStoreRow {
  readonly id: string;
  readonly merchant_id: string;
  readonly name: string;
  readonly type: string;
  readonly province: string | null;
  readonly city: string | null;
  readonly supports_pickup: number;
  readonly status: string;
}

/** `GET /merchant/products` 的查询条件。 */
export interface ListMerchantProductsInput {
  readonly scope: MerchantScope;
  readonly status?: string | undefined;
  readonly q?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

/** 分页结果。 */
export interface MerchantPage<T> {
  readonly rows: readonly T[];
  readonly total: number;
}

/* -------------------------------------------------------------------------- */
/* 商品                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 分页列出可见商品（**带行级隔离**）。
 *
 * 价格区间由子查询在 SQL 内聚合（`MIN` / `MAX`），避免「先分页再补价」导致
 * 的 N+1 与分页错位；无 SKU 的商品由 `COALESCE` 兜底为 `0`（`MoneySchema` 非负）。
 */
export async function listMerchantProducts(
  db: D1Database,
  input: ListMerchantProductsInput,
): Promise<MerchantPage<MerchantProductRow>> {
  const scopeClause = merchantScopeClause(input.scope, "p.merchant_id");
  const conditions: string[] = [scopeClause.clause];
  const args: unknown[] = [...scopeClause.args];

  if (input.status !== undefined) {
    conditions.push("p.status = ?");
    args.push(input.status);
  }
  if (input.categoryId !== undefined) {
    conditions.push("p.category_id = ?");
    args.push(input.categoryId);
  }
  if (input.q !== undefined && input.q.length > 0) {
    // `ESCAPE '\'` 与 escapeLike() 配对，防止 `%` / `_` 被当作通配符
    conditions.push("(p.title LIKE ? ESCAPE '\\' OR p.subtitle LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(input.q)}%`;
    args.push(pattern, pattern);
  }

  const where = conditions.join(" AND ");
  const offset = (input.page - 1) * input.pageSize;

  const priceSubquery = `(SELECT MIN(s.price) FROM product_skus s WHERE s.product_id = p.id)`;

  const [countRow, rows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM products p WHERE ${where}`)
      .bind(...args)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT p.id, p.title, p.subtitle, p.merchant_id, p.category_id, p.status,
                p.main_image, p.updated_at,
                COALESCE(${priceSubquery}, 0) AS min_price,
                COALESCE((SELECT MAX(s.price) FROM product_skus s WHERE s.product_id = p.id), 0) AS max_price
           FROM products p
          WHERE ${where}
          ORDER BY p.updated_at DESC, p.id DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...args, input.pageSize, offset)
      .all<MerchantProductRow>(),
  ]);

  return { rows: rows.results, total: countRow?.total ?? 0 };
}

/**
 * 取商品 SKU（只读，含库存）。
 *
 * ⚠️ 该函数**没有**对应端点：`MERCHANT_ENDPOINTS` 无 `/merchant/products/:spuId/skus`，
 * 保留导出供后续里程碑复用；当前仅被测试引用以锁定「可售 = stock - locked_stock」口径。
 */
export async function listMerchantSkus(
  db: D1Database,
  productId: string,
): Promise<MerchantSkuRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, product_id, sku_code, spec, price, stock, locked_stock, status
         FROM product_skus
        WHERE product_id = ?
        ORDER BY id ASC`,
    )
    .bind(productId)
    .all<MerchantSkuRow>();
  return rows.results;
}

/* -------------------------------------------------------------------------- */
/* 类目                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 列出类目（**平台级共享字典，不做商户过滤**，`MERCHANT_ENDPOINTS.CATEGORIES` 的
 * `merchantScoped = false`）。
 *
 * `level` 由 `parent_id` 链条在**应用层**推导：`categories` 表
 * （`packages/db/src/schema/product.ts`）**没有** `level` 列，
 * 而契约 `MerchantCategorySchema.level` 要求正整数（根为 `1`）。
 */
export async function listMerchantCategories(
  db: D1Database,
  input: { readonly page: number; readonly pageSize: number },
): Promise<MerchantPage<MerchantCategoryRow & { readonly level: number }>> {
  const offset = (input.page - 1) * input.pageSize;

  const [countRow, rows] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS total FROM categories").first<{ total: number }>(),
    db
      .prepare(
        `SELECT id, parent_id, name, sort_order, status
           FROM categories
          ORDER BY sort_order ASC, id ASC
          LIMIT ? OFFSET ?`,
      )
      .bind(input.pageSize, offset)
      .all<MerchantCategoryRow>(),
  ]);

  // 全表取 parent_id 链条用于计算层级：类目总量是小字典级（远小于分页上限），
  // 一次查询比逐行回溯 N 次更省往返。
  const all = await db
    .prepare("SELECT id, parent_id FROM categories")
    .all<{ id: string; parent_id: string | null }>();
  const parentById = new Map(all.results.map((row) => [row.id, row.parent_id]));

  return {
    rows: rows.results.map((row) => ({ ...row, level: categoryLevel(row.id, parentById) })),
    total: countRow?.total ?? 0,
  };
}

/** 计算类目层级：根为 `1`；链条断裂或成环时按已走深度收敛（绝不无限循环）。 */
function categoryLevel(id: string, parentById: ReadonlyMap<string, string | null>): number {
  let level = 1;
  let current = parentById.get(id) ?? null;
  const seen = new Set<string>([id]);
  while (current !== null && !seen.has(current) && level < 64) {
    seen.add(current);
    level += 1;
    current = parentById.get(current) ?? null;
  }
  return level;
}

/* -------------------------------------------------------------------------- */
/* 商户                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 列出可见商户（**带行级隔离**）。
 *
 * 隔离列是 `merchants.id` 本身：平台侧（`all = true`）返回全部商户，
 * 商户侧只返回自己（`MERCHANT_ENDPOINTS.MERCHANTS.merchantScoped = true`）。
 */
export async function listMerchantMerchants(
  db: D1Database,
  input: { readonly scope: MerchantScope; readonly page: number; readonly pageSize: number },
): Promise<MerchantPage<MerchantMerchantRow>> {
  const scopeClause = merchantScopeClause(input.scope, "m.id");
  const offset = (input.page - 1) * input.pageSize;

  const [countRow, rows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM merchants m WHERE ${scopeClause.clause}`)
      .bind(...scopeClause.args)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT m.id, m.name, m.type, m.status, m.contact_name, m.contact_phone, m.created_at
           FROM merchants m
          WHERE ${scopeClause.clause}
          ORDER BY m.created_at ASC, m.id ASC
          LIMIT ? OFFSET ?`,
      )
      .bind(...scopeClause.args, input.pageSize, offset)
      .all<MerchantMerchantRow>(),
  ]);

  return { rows: rows.results, total: countRow?.total ?? 0 };
}

/* -------------------------------------------------------------------------- */
/* 门店                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 列出可见门店 / 仓库（**带行级隔离**）。
 *
 * `stores.merchant_id` 是隔离列；平台侧返回全部门店。
 */
export async function listMerchantStores(
  db: D1Database,
  input: { readonly scope: MerchantScope; readonly page: number; readonly pageSize: number },
): Promise<MerchantPage<MerchantStoreRow>> {
  const scopeClause = merchantScopeClause(input.scope, "st.merchant_id");
  const offset = (input.page - 1) * input.pageSize;

  const [countRow, rows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM stores st WHERE ${scopeClause.clause}`)
      .bind(...scopeClause.args)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT st.id, st.merchant_id, st.name, st.type, st.province, st.city,
                st.supports_pickup, st.status
           FROM stores st
          WHERE ${scopeClause.clause}
          ORDER BY st.created_at ASC, st.id ASC
          LIMIT ? OFFSET ?`,
      )
      .bind(...scopeClause.args, input.pageSize, offset)
      .all<MerchantStoreRow>(),
  ]);

  return { rows: rows.results, total: countRow?.total ?? 0 };
}

/** 列表 IN 占位（供路由层批量补数用）。 */
export const catalogPlaceholders = placeholders;
