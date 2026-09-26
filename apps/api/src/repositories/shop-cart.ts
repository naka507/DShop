/**
 * C 端购物车仓储（`docs/06` §6 的 `/api/v1/shop/cart*`）。
 *
 * 表：`cart_items`（`uq_cart_items(user_id, sku_id)` 唯一）。
 *
 * ⚠️ 关联取值：购物车行本身只存 `sku_id` + `quantity`，展示所需的标题 / 规格 /
 * 单价一律**实时回查** `product_skus` + `products`（购物车不是快照，
 * 与 `order_items` 的下单快照语义相反——`docs/05` §5.3①）。
 *
 * ⚠️ 已删除的 SKU / 商品：用 `LEFT JOIN` 保留该行并标记 `available = false`，
 * 由前端提示「该商品已下架」。若改用 `INNER JOIN`，脏数据行会**静默消失**，
 * 用户看到的件数与实际不符。
 */

/* -------------------------------------------------------------------------- */
/* 行类型                                                                       */
/* -------------------------------------------------------------------------- */

/** 购物车行 + 关联的 SKU / 商品快照列（关联缺失时对应列为 `null`）。 */
export interface ShopCartRow {
  readonly id: string;
  readonly sku_id: string;
  readonly quantity: number;
  readonly created_at: string;
  readonly sku_code: string | null;
  readonly spec: string | null;
  readonly price: number | null;
  readonly stock: number | null;
  readonly locked_stock: number | null;
  readonly sku_status: string | null;
  readonly product_id: string | null;
  readonly title: string | null;
  readonly product_status: string | null;
  readonly merchant_id: string | null;
}

/* -------------------------------------------------------------------------- */
/* SQL 片段                                                                     */
/* -------------------------------------------------------------------------- */

const CART_SELECT = `
SELECT c.id AS id,
       c.sku_id AS sku_id,
       c.quantity AS quantity,
       c.created_at AS created_at,
       s.sku_code AS sku_code,
       s.spec AS spec,
       s.price AS price,
       s.stock AS stock,
       s.locked_stock AS locked_stock,
       s.status AS sku_status,
       s.product_id AS product_id,
       p.title AS title,
       p.status AS product_status,
       p.merchant_id AS merchant_id
  FROM cart_items c
  LEFT JOIN product_skus s ON s.id = c.sku_id
  LEFT JOIN products p ON p.id = s.product_id
 WHERE c.user_id = ?`;

/* -------------------------------------------------------------------------- */
/* 取数                                                                        */
/* -------------------------------------------------------------------------- */

/** 取该用户购物车全部行（按加入时间升序，稳定可预期）。 */
export async function listCartRows(db: D1Database, userId: string): Promise<ShopCartRow[]> {
  const res = await db
    .prepare(`${CART_SELECT} ORDER BY c.created_at ASC, c.id ASC`)
    .bind(userId)
    .all<ShopCartRow>();
  return res.results;
}

/**
 * 按行 id 集合取该用户的购物车行（结算用）。
 *
 * 传空数组时返回 `[]`——结算「指定行」语义下空集合不表示整车。
 * 查询始终带 `user_id = ?`，**行级归属在 SQL 里强制**（防越权操作他人购物车）。
 */
export async function listCartRowsByIds(
  db: D1Database,
  userId: string,
  itemIds: readonly string[],
): Promise<ShopCartRow[]> {
  if (itemIds.length === 0) return [];
  const placeholders = itemIds.map(() => "?").join(", ");
  const res = await db
    .prepare(`${CART_SELECT} AND c.id IN (${placeholders}) ORDER BY c.created_at ASC, c.id ASC`)
    .bind(userId, ...itemIds)
    .all<ShopCartRow>();
  return res.results;
}

/** 取单行（校验归属：`user_id` 不匹配即视为不存在，防枚举）。 */
export async function findCartRow(
  db: D1Database,
  userId: string,
  itemId: string,
): Promise<ShopCartRow | null> {
  return await db
    .prepare(`${CART_SELECT} AND c.id = ? LIMIT 1`)
    .bind(userId, itemId)
    .first<ShopCartRow>();
}

/* -------------------------------------------------------------------------- */
/* 写入                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 加购（`POST /shop/cart/items`）。
 *
 * 同 `(user_id, sku_id)` 已存在时**累加数量**（对齐 `uq_cart_items` 唯一约束的语义）。
 * 用 `ON CONFLICT ... DO UPDATE` 单语句完成，避免「先查再写」的并发覆盖。
 */
export async function upsertCartItem(
  db: D1Database,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly skuId: string;
    readonly quantity: number;
    readonly nowIso: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cart_items (id, user_id, sku_id, quantity, selected, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (user_id, sku_id)
       DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`,
    )
    .bind(input.id, input.userId, input.skuId, input.quantity, input.nowIso, input.nowIso)
    .run();
}

/**
 * 改数量（`PUT /shop/cart/items/:id`）。
 *
 * `quantity = 0` 的语义是**删除该行**（`ShopCartItemUpdateBodySchema` 的注释），
 * 由调用方决定调本函数还是 `deleteCartItem`。
 */
export async function updateCartItemQuantity(
  db: D1Database,
  userId: string,
  itemId: string,
  quantity: number,
  nowIso: string,
): Promise<void> {
  await db
    .prepare("UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(quantity, nowIso, itemId, userId)
    .run();
}

/** 删除购物车行（同样带 `user_id` 归属约束）。 */
export async function deleteCartItem(
  db: D1Database,
  userId: string,
  itemId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM cart_items WHERE id = ? AND user_id = ?")
    .bind(itemId, userId)
    .run();
}

/** 下单成功后移除已结算的购物车行。 */
export async function deleteCartItems(
  db: D1Database,
  userId: string,
  itemIds: readonly string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const placeholders = itemIds.map(() => "?").join(", ");
  await db
    .prepare(`DELETE FROM cart_items WHERE user_id = ? AND id IN (${placeholders})`)
    .bind(userId, ...itemIds)
    .run();
}
