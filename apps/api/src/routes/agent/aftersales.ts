/**
 * `GET /api/v1/agent/aftersales/{aftersaleNo}` 与 `GET /api/v1/agent/policies/{category}`
 * （`docs/07` §7.6 / §7.7）。
 */

import {
  AgentAftersaleDetailParamsSchema,
  AgentAftersaleDetailSchema,
  AgentPoliciesSchema,
  PolicyQueryCategorySchema,
} from "@dshop/shared";
import { maskAgentPayload } from "@dshop/services";
import { Hono } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import {
  aftersaleNotFound,
  invalidParam,
  policyNotEffective,
  successResponse,
} from "../../lib/errors.js";
import { findAftersaleByNo, findPoliciesByCategory } from "../../repositories/aftersales.js";
import { mapAftersaleDetail, mapPolicies } from "./mappers.js";

export const aftersaleRoutes = new Hono<AppEnv & { Bindings: Env }>();

/**
 * `GET /aftersales/{aftersaleNo}` —— 售后单状态。
 *
 * 凭证图 URL **绝不下发**，只给 `evidenceCount`；`returnAddress` 同样经脱敏。
 */
aftersaleRoutes.get("/aftersales/:aftersaleNo", async (c) => {
  const parsed = AgentAftersaleDetailParamsSchema.safeParse({
    aftersaleNo: c.req.param("aftersaleNo"),
  });
  if (!parsed.success) return invalidParam("aftersaleNo 格式非法（须为 ^AS\\d{11}$）");

  const aggregate = await findAftersaleByNo(c.env.DB, parsed.data.aftersaleNo);
  if (aggregate === null) {
    return aftersaleNotFound(`售后单不存在：${parsed.data.aftersaleNo}`);
  }

  // `Cache-Control` / `X-Cache` 由 `withEdgeCache()` 按 `AGENT_ENDPOINTS` 统一落头。
  return successResponse(
    maskAgentPayload(
      AgentAftersaleDetailSchema,
      mapAftersaleDetail(aggregate),
      "GET /aftersales/{aftersaleNo}",
    ),
  );
});

/**
 * `GET /policies/{category}` —— 售后政策条款（PiEcho 政策语料唯一来源）。
 *
 * 无生效条款 → `40404`。
 */
aftersaleRoutes.get("/policies/:category", async (c) => {
  const parsed = PolicyQueryCategorySchema.safeParse(c.req.param("category"));
  if (!parsed.success) {
    return invalidParam(
      "category 非法：须为 return / refund / exchange / freight / warranty / all",
    );
  }

  const rows = await findPoliciesByCategory(c.env.DB, parsed.data);
  if (rows.length === 0) {
    return policyNotEffective(`政策分类无生效条款：${parsed.data}`);
  }

  return successResponse(
    maskAgentPayload(
      AgentPoliciesSchema,
      await mapPolicies(parsed.data, rows),
      "GET /policies/{category}",
    ),
  );
});
