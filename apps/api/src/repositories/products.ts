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
