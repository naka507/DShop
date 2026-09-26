/**
 * C 端购物车与结算路由（`docs/06` §6 的 `/api/v1/shop/cart*` 与 `/shop/checkout/preview`）。
 *
 * - `GET    /shop/cart`              —— 购物车
 * - `POST   /shop/cart/items`        —— 加购
 * - `PUT    /shop/cart/items/:id`    —— 改数量（`quantity = 0` 即删除）
 * - `DELETE /shop/cart/items/:id`    —— 删除
 * - `GET    /shop/checkout/preview`  —— 结算试算
 *
 * **全部需登录**（购物车属会员数据，`docs/06:11`）。
 * 所有写接口都返回**整份购物车**（`ShopCartSchema`），
 * 使前端无需二次拉取即可刷新角标与总价。
 */

import {
  ShopCartItemAddBodySchema,
  ShopCartItemParamsSchema,
  ShopCartItemUpdateBodySchema,
  ShopCartSchema,
  ShopCheckoutPreviewQuerySchema,
  ShopCheckoutPreviewSchema,
  newId,
} from "@dshop/shared";
import { Hono } from "hono";
import type { Context } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { successResponse } from "../../lib/errors.js";
import {
  deleteCartItem,
  findCartRow,
  listCartRows,
  listCartRowsByIds,
  updateCartItemQuantity,
  upsertCartItem,
} from "../../repositories/shop-cart.js";
import { shopError, shopInvalidParam } from "./errors.js";
import { requireShopAuth } from "./guard.js";
import { mapCart, mapCheckoutPreview } from "./mappers.js";

export const cartRoutes = new Hono<AppEnv & { Bindings: Env }>();

/** 取当前登录用户 id（`requireShopAuth()` 已保证主体存在）。 */
function currentUserId(c: Context<AppEnv & { Bindings: Env }>): string {
  return c.get("adminSubject").sub;
}

/** 读取请求体 JSON；失败返回 `null`。 */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** 读取当前用户购物车并组装响应。 */
async function cartResponse(db: D1Database, userId: string): Promise<Response> {
  const rows = await listCartRows(db, userId);
  const validated = ShopCartSchema.safeParse(mapCart(rows));
  if (!validated.success) return shopError("INTERNAL_ERROR", "购物车响应不符合契约");
  return successResponse(validated.data);
}

/* -------------------------------------------------------------------------- */
/* 读                                                                          */
/* -------------------------------------------------------------------------- */

/** `GET /shop/cart`。 */
cartRoutes.get("/cart", requireShopAuth(), async (c) => cartResponse(c.env.DB, currentUserId(c)));

/* -------------------------------------------------------------------------- */
/* 写                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `POST /shop/cart/items` —— 加购。
 *
 * 先校验 SKU 存在且在售（避免把已下架商品写进购物车）；
 * 同 SKU 已在车内时由仓储的 `ON CONFLICT` 累加数量。
 */
cartRoutes.post("/cart/items", requireShopAuth(), async (c) => {
  const raw = await readJson(c);
  if (raw === null) return shopInvalidParam("请求体不是合法 JSON");

  const parsed = ShopCartItemAddBodySchema.safeParse(raw);
  if (!parsed.success) return shopInvalidParam("skuId 或 quantity 非法");

  const sku = await findSkuForCart(c.env.DB, parsed.data.skuId);
  if (sku === null) return shopError("PRODUCT_NOT_FOUND", "商品不存在或已下架");

  const userId = currentUserId(c);
  await upsertCartItem(c.env.DB, {
    id: newId(),
    userId,
    skuId: parsed.data.skuId,
    quantity: parsed.data.quantity,
    nowIso: new Date().toISOString(),
  });

  return cartResponse(c.env.DB, userId);
});

/**
 * `PUT /shop/cart/items/:id` —— 改数量。
 *
 * ⚠️ `quantity = 0` 的语义是**删除该行**（`ShopCartItemUpdateBodySchema` 的注释，
 * 与前端 `updateCartItem` 的 JSDoc 一致），故下界为 0 而非 1。
 */
cartRoutes.put("/cart/items/:id", requireShopAuth(), async (c) => {
  const params = ShopCartItemParamsSchema.safeParse({ id: c.req.param("id") });
  if (!params.success) return shopInvalidParam("购物车行 id 格式非法（须为 26 位 ULID）");

  const raw = await readJson(c);
  if (raw === null) return shopInvalidParam("请求体不是合法 JSON");

  const body = ShopCartItemUpdateBodySchema.safeParse(raw);
  if (!body.success) return shopInvalidParam("quantity 非法（须为非负整数）");

  const userId = currentUserId(c);
  const existing = await findCartRow(c.env.DB, userId, params.data.id);
  if (existing === null) return shopError("NOT_FOUND", "购物车行不存在");

  if (body.data.quantity === 0) {
    await deleteCartItem(c.env.DB, userId, params.data.id);
  } else {
    await updateCartItemQuantity(
      c.env.DB,
      userId,
      params.data.id,
      body.data.quantity,
      new Date().toISOString(),
    );
  }

  return cartResponse(c.env.DB, userId);
});

/** `DELETE /shop/cart/items/:id` —— 删除（幂等：不存在也返回当前购物车）。 */
cartRoutes.delete("/cart/items/:id", requireShopAuth(), async (c) => {
  const params = ShopCartItemParamsSchema.safeParse({ id: c.req.param("id") });
  if (!params.success) return shopInvalidParam("购物车行 id 格式非法（须为 26 位 ULID）");

  const userId = currentUserId(c);
  await deleteCartItem(c.env.DB, userId, params.data.id);
  return cartResponse(c.env.DB, userId);
});

/* -------------------------------------------------------------------------- */
/* 结算试算                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `GET /shop/checkout/preview` —— 结算试算。
 *
 * `itemIds` 为**逗号分隔**的购物车行 id（前端 `join(",")`）；
 * 省略即整车结算。指定集合时**只取属于当前用户的行**（归属在 SQL 里强制）。
 */
cartRoutes.get("/checkout/preview", requireShopAuth(), async (c) => {
  const parsed = ShopCheckoutPreviewQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return shopInvalidParam("查询参数非法");

  const userId = currentUserId(c);
  const itemIds =
    parsed.data.itemIds === undefined
      ? []
      : parsed.data.itemIds
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

  const rows =
    itemIds.length === 0
      ? await listCartRows(c.env.DB, userId)
      : await listCartRowsByIds(c.env.DB, userId, itemIds);

  const validated = ShopCheckoutPreviewSchema.safeParse(mapCheckoutPreview(rows));
  if (!validated.success) return shopError("INTERNAL_ERROR", "结算试算响应不符合契约");

  return successResponse(validated.data);
});

/* -------------------------------------------------------------------------- */
/* 内部                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 校验 SKU 可加购（`product_skus.status = 'active'` 且所属商品 `onsale`）。
 *
 * 复用 `findShopProductDetail` 会多查两张表，故这里走一条轻量 JOIN 查询
 * （**不新建仓储文件**：`shop-catalog.ts` 已承载商品侧查询，本函数在其语义内）。
 */
async function findSkuForCart(db: D1Database, skuId: string): Promise<{ skuId: string } | null> {
  const row = await db
    .prepare(
      `SELECT s.id AS id
         FROM product_skus s
         JOIN products p ON p.id = s.product_id
        WHERE s.id = ? AND s.status = 'active' AND p.status = 'onsale'
        LIMIT 1`,
    )
    .bind(skuId)
    .first<{ id: string }>();
  return row === null ? null : { skuId: row.id };
}
