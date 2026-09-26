/**
 * `GET /api/v1/agent/products/{spuId}/specs` 与 `.../stock`（`docs/07` §7.4 / §7.5）。
 */

import {
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
import { findProductSpecs, findProductStock } from "../../repositories/products.js";
import { mapProductSpecs, mapProductStock } from "./mappers.js";

export const productRoutes = new Hono<AppEnv & { Bindings: Env }>();

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
