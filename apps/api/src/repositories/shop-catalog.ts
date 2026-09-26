/**
 * C 端商品 / 分类仓储（`docs/06` §6 的 `/api/v1/shop/products*` 与 `/shop/categories`）。
 *
 * 设计约束与 `repositories/products.ts` 一致：原生 D1 API、**显式列名**、无 `SELECT *`。
 *
 * ⚠️ 与 Agent 面的差异（`packages/shared/src/contracts/shop.ts` 文件头）：
 * C 端是数据归属方本人，故**不脱敏**；但内部字段仍不下发——
 * `product_attrs.searchable`、`products.merchant_id`（列表页不需要）不取出。
 *
 * ⚠️ 销量排序缺口：`docs/03` §3.5.1 的排序标识含 `sales_desc`，但 41 张表里
 * **没有**销量聚合列（`order_items` 只按 `sub_order_id` 索引）。故 `sales_desc`
 * 降级为「按 `created_at` 倒序」并在注释标注，**不臆造列**（`docs/05` §5.2）。
 */

import type { ProductStatus, SkuStatus } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 行类型（snake_case，与 SQL 列一一对应）                                      */
/* -------------------------------------------------------------------------- */

/** `categories` 行（仅树所需三列）。 */
export interface ShopCategoryRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
}

/** 商品列表行（`min_price` 为在售 SKU 的起售价，无在售 SKU 时为 `null`）。 */
export interface ShopProductListRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly brand: string | null;
  readonly main_image: string | null;
  readonly status: ProductStatus;
  readonly min_price: number | null;
}

/** 商品详情主体行（含 `detail_html`）。 */
export interface ShopProductDetailRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly brand: string | null;
  readonly main_image: string | null;
  readonly detail_html: string | null;
  readonly status: ProductStatus;
}

/** `product_attrs` 行（**不含** `searchable`）。 */
export interface ShopProductAttrRow {
  readonly group_name: string;
  readonly attr_name: string;
  readonly attr_value: string;
  readonly sort_order: number;
}

/** `product_skus` 行（详情页 SKU）。 */
export interface ShopProductSkuRow {
  readonly id: string;
  readonly sku_code: string;
  readonly spec: string;
  readonly price: number;
  readonly stock: number;
  readonly locked_stock: number;
  readonly status: SkuStatus;
}

/** 商品详情聚合体。 */
export interface ShopProductDetailAggregate {
  readonly product: ShopProductDetailRow;
  readonly attrs: readonly ShopProductAttrRow[];
  readonly skus: readonly ShopProductSkuRow[];
}

/** 商品列表查询条件。 */
export interface ShopProductListInput {
  readonly categoryId?: string | undefined;
  /** 关键词（标题 / 品牌模糊匹配）。 */
  readonly q?: string | undefined;
  /** 排序标识；未识别一律回退默认排序。 */
  readonly sort?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
}

/** 商品列表结果。 */
export interface ShopProductListResult {
  readonly rows: readonly ShopProductListRow[];
  readonly total: number;
}

/* -------------------------------------------------------------------------- */
/* SQL 片段                                                                     */
/* -------------------------------------------------------------------------- */

const PRODUCT_LIST_COLUMNS =
  "p.id, p.title, p.subtitle, p.brand, p.main_image, p.status, " +
  "(SELECT MIN(s.price) FROM product_skus s WHERE s.product_id = p.id AND s.status = 'active') AS min_price";

const PRODUCT_DETAIL_COLUMNS = "id, title, subtitle, brand, main_image, detail_html, status";

const SKU_COLUMNS = "id, sku_code, spec, price, stock, locked_stock, status";

/**
 * 排序标识 → `ORDER BY` 子句（`docs/03` §3.5.1 的排序标识）。
 *
 * ⚠️ `sales_desc` 无销量列可依（见文件头缺口说明），降级为创建时间倒序。
 * 未识别的标识同样回退默认排序，**不报错**——排序是展示优化，不该阻断浏览。
 */
export function orderByClauseForSort(sort: string | undefined): string {
  switch (sort) {
    case "price_asc":
      return "min_price ASC, p.id ASC";
    case "price_desc":
      return "min_price DESC, p.id ASC";
    case "newest":
    case "sales_desc":
    default:
      return "p.created_at DESC, p.id DESC";
  }
}

/* -------------------------------------------------------------------------- */
/* 取数                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 取全部启用分类（扁平行，树在路由层组装）。
 *
 * `categories.status` 未在 `@dshop/shared` 定义枚举（05 §5.2 只给默认值 `active`），
 * 故按字面量 `'active'` 过滤，与 `repositories/products.ts` 的 `stores.status` 同风格。
 */
export async function listShopCategoryRows(db: D1Database): Promise<ShopCategoryRow[]> {
  const res = await db
    .prepare(
      `SELECT id, parent_id, name
         FROM categories
        WHERE status = 'active'
        ORDER BY sort_order ASC, name ASC`,
    )
    .all<ShopCategoryRow>();
  return res.results;
}

/**
 * 分页列出在售商品（首页 / 分类 / 搜索共用）。
 *
 * 过滤条件：`products.status = 'onsale'`（下架 / 草稿不出现在 C 端列表）。
 */
export async function listShopProducts(
  db: D1Database,
  input: ShopProductListInput,
): Promise<ShopProductListResult> {
  const conditions: string[] = ["p.status = 'onsale'"];
  const args: unknown[] = [];

  if (input.categoryId !== undefined && input.categoryId.length > 0) {
    conditions.push("p.category_id = ?");
    args.push(input.categoryId);
  }
  if (input.q !== undefined && input.q.length > 0) {
    conditions.push("(p.title LIKE ? OR p.brand LIKE ?)");
    const pattern = `%${input.q}%`;
    args.push(pattern, pattern);
  }

  const where = conditions.join(" AND ");
  const offset = (input.page - 1) * input.pageSize;

  const [rowRes, countRes] = await Promise.all([
    db
      .prepare(
        `SELECT ${PRODUCT_LIST_COLUMNS}
           FROM products p
          WHERE ${where}
          ORDER BY ${orderByClauseForSort(input.sort)}
          LIMIT ? OFFSET ?`,
      )
      .bind(...args, input.pageSize, offset)
      .all<ShopProductListRow>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM products p WHERE ${where}`)
      .bind(...args)
      .first<{ total: number }>(),
  ]);

  return { rows: rowRes.results, total: countRes?.total ?? 0 };
}

/**
 * 取商品详情聚合体：`products` + `product_attrs` + `product_skus`。
 *
 * SPU 不存在返回 `null`（路由回 `ERR_SHOP_PRODUCT_NOT_FOUND`）。
 * **下架判定留给路由层**——仓储只负责取数，不做下发决策（同 `repositories/products.ts`）。
 */
export async function findShopProductDetail(
  db: D1Database,
  spuId: string,
): Promise<ShopProductDetailAggregate | null> {
  const product = await db
    .prepare(`SELECT ${PRODUCT_DETAIL_COLUMNS} FROM products WHERE id = ? LIMIT 1`)
    .bind(spuId)
    .first<ShopProductDetailRow>();
  if (product === null) return null;

  const [attrRes, skuRes] = await Promise.all([
    db
      .prepare(
        `SELECT group_name, attr_name, attr_value, sort_order
           FROM product_attrs
          WHERE spu_id = ?
          ORDER BY sort_order ASC, attr_name ASC`,
      )
      .bind(spuId)
      .all<ShopProductAttrRow>(),
    db
      .prepare(
        `SELECT ${SKU_COLUMNS}
           FROM product_skus
          WHERE product_id = ? AND status = 'active'
          ORDER BY sku_code ASC`,
      )
      .bind(spuId)
      .all<ShopProductSkuRow>(),
  ]);

  return { product, attrs: attrRes.results, skus: skuRes.results };
}
