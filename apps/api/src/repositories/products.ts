/**
 * 商品仓储（Agent 只读契约 `docs/07` §7.4 / §7.5）。
 *
 * 设计约束同 `orders.ts`：原生 D1 API、显式列名、无 `SELECT *`。
 * `products.detail_html` 与 `product_attrs.searchable` 属内部字段，**不取出**。
 */

import type { ProductStatus, SkuStatus } from "@dshop/shared";

import { contentHashOf } from "./json.js";

/* -------------------------------------------------------------------------- */
/* 行类型                                                                       */
/* -------------------------------------------------------------------------- */

/** `products` 行（仅 Agent 需要的列）。 */
export interface ProductRow {
  readonly id: string;
  readonly merchant_id: string;
  readonly category_path: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly main_image: string | null;
  readonly brand: string | null;
  readonly status: ProductStatus;
  readonly updated_at: string;
}

/** `product_attrs` 行。 */
export interface ProductAttrRow {
  readonly group_name: string;
  readonly attr_name: string;
  readonly attr_value: string;
  readonly unit: string | null;
  readonly sort_order: number;
}

/** `product_skus` 行。 */
export interface ProductSkuRow {
  readonly id: string;
  readonly sku_code: string;
  readonly spec: string;
  readonly price: number;
  readonly market_price: number | null;
  readonly stock: number;
  readonly locked_stock: number;
  readonly restock_eta: string | null;
  readonly status: SkuStatus;
  readonly updated_at: string;
}

/** `/specs` 的取数结果。 */
export interface ProductSpecsAggregate {
  readonly product: ProductRow;
  readonly attrs: readonly ProductAttrRow[];
  readonly skus: readonly ProductSkuRow[];
}

/** `/stock` 的取数结果。 */
export interface ProductStockAggregate {
  readonly product: ProductRow;
  readonly skus: readonly ProductSkuRow[];
  /** 该商品所属 merchant 的仓库/门店（`shipFrom` 来源）。 */
  readonly stores: readonly ProductStockStoreRow[];
}

/** `/products?q=` 的检索结果行。 */
export interface ProductSearchRow {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly brand: string | null;
  readonly category_path: string;
  readonly status: ProductStatus;
  readonly min_price: number | null;
}

/** `/stock` 的 `shipFrom` 来源行。 */
export interface ProductStockStoreRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly province: string | null;
  readonly city: string | null;
  readonly supports_pickup: number;
}

/* -------------------------------------------------------------------------- */
/* SQL 片段                                                                     */
/* -------------------------------------------------------------------------- */

const PRODUCT_COLUMNS =
  "id, merchant_id, category_path, title, subtitle, main_image, brand, status, updated_at";
const SKU_COLUMNS =
  "id, sku_code, spec, price, market_price, stock, locked_stock, restock_eta, status, updated_at";

/**
 * 检索用列。
 *
 * ⚠️ **不取 `main_image`**：它现在是 `data:image/png;base64,…`（数 KB 字符串），
 * 而本端点用途是「名称 → SPU ID」，图片只会白白吃掉模型上下文预算。
 */
const PRODUCT_SEARCH_COLUMNS =
  "p.id, p.title, p.subtitle, p.brand, p.category_path, p.status, " +
  "(SELECT MIN(s.price) FROM product_skus s WHERE s.product_id = p.id AND s.status = 'active') AS min_price";

/* -------------------------------------------------------------------------- */
/* 取数                                                                        */
/* -------------------------------------------------------------------------- */

/** 取 SPU 规格白皮书：`products` + `product_attrs` + `product_skus`；SPU 不存在返回 `null`。 */
export async function findProductSpecs(
  db: D1Database,
  spuId: string,
): Promise<ProductSpecsAggregate | null> {
  const product = await db
    .prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? LIMIT 1`)
    .bind(spuId)
    .first<ProductRow>();
  if (product === null) return null;

  const [attrRows, skuRows] = await Promise.all([
    db
      .prepare(
        `SELECT group_name, attr_name, attr_value, unit, sort_order
           FROM product_attrs
          WHERE spu_id = ?
          ORDER BY sort_order ASC, attr_name ASC`,
      )
      .bind(spuId)
      .all<ProductAttrRow>(),
    db
      .prepare(`SELECT ${SKU_COLUMNS} FROM product_skus WHERE product_id = ? ORDER BY sku_code ASC`)
      .bind(spuId)
      .all<ProductSkuRow>(),
  ]);

  return { product, attrs: attrRows.results, skus: skuRows.results };
}

/** 取 SPU 库存：`products` + `product_skus` + 所属 merchant 的 `stores`；SPU 不存在返回 `null`。 */
export async function findProductStock(
  db: D1Database,
  spuId: string,
): Promise<ProductStockAggregate | null> {
  const product = await db
    .prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? LIMIT 1`)
    .bind(spuId)
    .first<ProductRow>();
  if (product === null) return null;

  const [skuRows, storeRows] = await Promise.all([
    db
      .prepare(`SELECT ${SKU_COLUMNS} FROM product_skus WHERE product_id = ? ORDER BY sku_code ASC`)
      .bind(spuId)
      .all<ProductSkuRow>(),
    db
      .prepare(
        `SELECT id, name, type, province, city, supports_pickup
           FROM stores
          WHERE merchant_id = ? AND status = 'active'
          ORDER BY type ASC, name ASC`,
      )
      .bind(product.merchant_id)
      .all<ProductStockStoreRow>(),
  ]);

  return { product, skus: skuRows.results, stores: storeRows.results };
}

/**
 * 计算规格内容哈希（`/specs` 的 `contentHash`，供 PiEcho 感知变化）。
 *
 * 算法：先做**键排序的规范化 JSON 序列化**（`stableStringify`），再取 SHA-256 hex；
 * 输出带 `sha256:` 前缀，与 `docs/07` §7.4 示例一致。同一内容任意次调用结果一致。
 */
export async function computeContentHash(input: unknown): Promise<string> {
  return contentHashOf(input);
}

/**
 * 按关键词检索商品（`/products?q=`，`docs/07` §7.4a）。
 *
 * ## 语义（三条都是刻意的，不要"优化"掉）
 *
 * 1. **不过滤 `status`**：`off_sale` / `draft` 也会被搜到。用户可能提到一个已下架的商品，
 *    此时模型应能回答「该商品已下架」，而不是「找不到该商品」——后者会诱发幻觉
 *    （模型会转而编造一个 SPU ID）。`status` 字段随行下发供模型判断。
 * 2. **无匹配不是错误**：返回 `{ rows: [], total: 0 }`，路由层据此回 HTTP 200 + 空数组。
 *    **绝不** 404——模型必须能区分「没搜到」与「查询失败」。
 * 3. **不取 `main_image`**：见 `PRODUCT_SEARCH_COLUMNS` 的说明。
 *
 * 匹配口径与 C 端 `shop-catalog.ts` 的 `listShopProducts` 一致（`title` / `brand` 的
 * `LIKE` 模糊匹配），但**列名与返回形状不同**（Agent 面额外给 `categoryPath` 与 `minPrice`，
 * 且这里刻意不过滤上架状态），故不共用函数。
 *
 * 排序：在售优先 → 创建时间倒序 → id 倒序（最后一项保证分页稳定）。
 */
export async function searchProducts(
  db: D1Database,
  input: { readonly q: string; readonly limit: number },
): Promise<{ rows: ProductSearchRow[]; total: number }> {
  // 参数化绑定，绝不拼接字符串（`q` 来自外部输入）。
  const pattern = `%${input.q}%`;
  const where = "(p.title LIKE ? OR p.brand LIKE ?)";

  const [rowRes, countRes] = await Promise.all([
    db
      .prepare(
        `SELECT ${PRODUCT_SEARCH_COLUMNS}
           FROM products p
          WHERE ${where}
          ORDER BY CASE WHEN p.status = 'onsale' THEN 0 ELSE 1 END ASC,
                   p.created_at DESC,
                   p.id DESC
          LIMIT ?`,
      )
      .bind(pattern, pattern, input.limit)
      .all<ProductSearchRow>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM products p WHERE ${where}`)
      .bind(pattern, pattern)
      .first<{ total: number }>(),
  ]);

  return { rows: rowRes.results, total: countRes?.total ?? 0 };
}
