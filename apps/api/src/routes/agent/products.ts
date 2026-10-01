/**
 * `GET /api/v1/agent/products`（检索，`docs/07` §7.4a）
 * 与 `.../products/{spuId}/specs`、`.../stock`（按 ID 查，§7.4 / §7.5）。
 *
 * ⚠️ 检索端点与按 ID 查的端点同挂 `productRoutes`。**Hono 的 `use("/products")` 只精确匹配
 * `/products`**，不会命中 `/products/{spuId}/specs`，故三者的 `endpointTemplate`、限流与
 * 边缘缓存互不干扰（已用探针实测两种注册顺序，均正确隔离）。
 */

import {
  AgentProductSearchQuerySchema,
  AgentProductSearchSchema,
  AgentProductSpecsParamsSchema,
  AgentProductSpecsSchema,
  AgentProductStockParamsSchema,
  AgentProductStockQuerySchema,
  AgentProductStockSchema,
} from "@dshop/shared";
import { maskAgentPayload } from "@dshop/services";
import { Hono } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { invalidParam, productNotFound, successResponse } from "../../lib/errors.js";
import { findProductSpecs, findProductStock, searchProducts } from "../../repositories/products.js";
import { mapProductSearch, mapProductSpecs, mapProductStock } from "./mappers.js";

export const productRoutes = new Hono<AppEnv & { Bindings: Env }>();

/**
 * `GET /products` —— 按关键词检索商品（`docs/07` §7.4a）。
 *
 * ## 为什么需要这个端点
 *
 * `product_spec` 要求 26 位 ULID `spuId`，而模型无从把用户说的商品名映射到 SPU ID
 * → 必然编造 → ULID 守卫拒绝（`docs/09` R26 缺口②）。本端点补上「名称 → SPU ID」这一环。
 *
 * ## 三条刻意语义（不要"优化"）
 *
 * 1. **无匹配返回 200 + 空数组，绝不 404**：模型必须能区分「没搜到」与「查询失败」，
 *    否则它会退化成编造 SPU ID。
 * 2. **不过滤 `status`**：已下架商品也要能被搜到，模型才能回答「该商品已下架」。
 * 3. **不下发 `mainImage`**：它是 `data:image/png;base64,…` 大字符串，会吃爆上下文预算。
 */
productRoutes.get("/products", async (c) => {
  const query = AgentProductSearchQuerySchema.safeParse(c.req.query());
  if (!query.success) return invalidParam("查询参数非法：q 须为 1–64 字符，limit 须为 1–20");

  const { rows, total } = await searchProducts(c.env.DB, {
    q: query.data.q,
    limit: query.data.limit,
  });

  // 无匹配是**正常结果**（HTTP 200 + 空数组），不是 404。
  return successResponse(
    maskAgentPayload(
      AgentProductSearchSchema,
      mapProductSearch(query.data.q, rows, total),
      "GET /products",
    ),
  );
});
/**
 * `GET /products/{spuId}/specs` —— 商品规格 / 参数白皮书。
 *
 * `skus[]` **不含库存数值**，仅 `inStock`（库存走 `/stock` 端点）。
 */
productRoutes.get("/products/:spuId/specs", async (c) => {
  const parsed = AgentProductSpecsParamsSchema.safeParse({ spuId: c.req.param("spuId") });
  if (!parsed.success) return invalidParam("spuId 须为 26 位 ULID");

  const aggregate = await findProductSpecs(c.env.DB, parsed.data.spuId);
  if (aggregate === null) return productNotFound(`商品不存在：${parsed.data.spuId}`);

  // `Cache-Control` / `X-Cache` 由 `withEdgeCache()` 按 `AGENT_ENDPOINTS` 统一落头。
  return successResponse(
    maskAgentPayload(
      AgentProductSpecsSchema,
      await mapProductSpecs(aggregate),
      "GET /products/{spuId}/specs",
    ),
  );
});

/**
 * `GET /products/{spuId}/stock` —— 库存与发货地。
 *
 * `stock` 是可售库存（`stock - locked_stock`）；`available` = 目标数量 ≤ 可售。
 */
productRoutes.get("/products/:spuId/stock", async (c) => {
  const params = AgentProductStockParamsSchema.safeParse({ spuId: c.req.param("spuId") });
  if (!params.success) return invalidParam("spuId 须为 26 位 ULID");

  const query = AgentProductStockQuerySchema.safeParse(c.req.query());
  if (!query.success) return invalidParam("查询参数非法：skuId 须为 ULID，quantity 须为正整数");

  const aggregate = await findProductStock(c.env.DB, params.data.spuId);
  if (aggregate === null) return productNotFound(`商品不存在：${params.data.spuId}`);

  return successResponse(
    maskAgentPayload(
      AgentProductStockSchema,
      mapProductStock(aggregate, query.data.quantity, query.data.skuId),
      "GET /products/{spuId}/stock",
    ),
  );
});
