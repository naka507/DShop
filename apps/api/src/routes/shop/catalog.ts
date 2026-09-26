/**
 * C 端浏览路由（`docs/06` §6 的 `/api/v1/shop/products*` 与 `/shop/categories`）。
 *
 * - `GET /shop/products`          —— 列表（`categoryId` / `q` / `sort` / 分页）
 * - `GET /shop/categories`        —— 分类树
 * - `GET /shop/products/:spuId`   —— 详情
 *
 * **公开端点，无需登录**（`docs/06:11`：C 端「公开浏览 + 会员」）。
 */

import {
  ShopProductDetailParamsSchema,
  ShopProductDetailSchema,
  ShopProductListQuerySchema,
  ShopProductListSchema,
} from "@dshop/shared";
import { getReadDb } from "@dshop/services";
import { Hono } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { successResponse } from "../../lib/errors.js";
import {
  findShopProductDetail,
  listShopCategoryRows,
  listShopProducts,
} from "../../repositories/shop-catalog.js";
import { shopError, shopInvalidParam } from "./errors.js";
import { buildCategoryTree, mapProductDetail, mapProductSummary } from "./mappers.js";

export const catalogRoutes = new Hono<AppEnv & { Bindings: Env }>();

/**
 * `GET /shop/products` —— 商品列表。
 *
 * 分页为后台组统一形态 `{ page, pageSize, total, list }`（`docs/06` §6）。
 */
catalogRoutes.get("/products", async (c) => {
  const parsed = ShopProductListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return shopInvalidParam("查询参数非法");

  const query = parsed.data;
  // 升级缝 S2：只读查询走 `getReadDb`（`docs/04` §4.3）。无 `READ_DB` 绑定时
  // 它**返回 `env.DB` 本身**，故默认行为零变化；加只读副本绑定即自动分流。
  const result = await listShopProducts(getReadDb(c.env), {
    categoryId: query.categoryId,
    q: query.q,
    sort: query.sort,
    page: query.page,
    pageSize: query.pageSize,
  });

  const data = {
    page: query.page,
    pageSize: query.pageSize,
    total: result.total,
    list: result.rows.map(mapProductSummary),
  };

  // 契约自检：组装结果必须能被 `ShopProductListSchema` 解析（防字段漂移）
  const validated = ShopProductListSchema.safeParse(data);
  if (!validated.success) return shopError("INTERNAL_ERROR", "商品列表响应不符合契约");

  return successResponse(validated.data);
});

/** `GET /shop/categories` —— 分类树（`parentId` 为 `null` 即根）。 */
catalogRoutes.get("/categories", async (c) => {
  const rows = await listShopCategoryRows(getReadDb(c.env));
  return successResponse(buildCategoryTree(rows));
});

/**
 * `GET /shop/products/:spuId` —— 商品详情。
 *
 * 仅下架商品对 C 端不可见：`products.status != 'onsale'` 一律按
 * `ERR_SHOP_PRODUCT_NOT_FOUND` 处理（`SHOP_ERROR_CODES.PRODUCT_NOT_FOUND`
 * 的语义注释：「商品不存在或已下架」，两者**不区分**）。
 */
catalogRoutes.get("/products/:spuId", async (c) => {
  const parsed = ShopProductDetailParamsSchema.safeParse({ spuId: c.req.param("spuId") });
  if (!parsed.success) return shopInvalidParam("spuId 格式非法（须为 26 位 ULID）");

  const aggregate = await findShopProductDetail(getReadDb(c.env), parsed.data.spuId);
  if (aggregate === null || aggregate.product.status !== "onsale") {
    return shopError("PRODUCT_NOT_FOUND", "商品不存在或已下架");
  }

  const validated = ShopProductDetailSchema.safeParse(mapProductDetail(aggregate));
  if (!validated.success) return shopError("INTERNAL_ERROR", "商品详情响应不符合契约");

  return successResponse(validated.data);
});
