/**
 * `GET /api/v1/agent/orders/{orderNo}` 与 `GET /api/v1/agent/orders`
 * （`docs/07` §7.2 / §7.3）。
 *
 * 路由层职责：参数校验 → 取数 → 映射 → 信封封装。所有脱敏在 `mappers.ts` 完成。
 */

import { normalizePhone, hashPhone } from "@dshop/auth";
import {
  AgentOrderDetailParamsSchema,
  AgentOrderDetailSchema,
  AgentOrderListQuerySchema,
  AgentOrderListSchema,
  parseStatusFilter,
} from "@dshop/shared";
import { maskAgentPayload } from "@dshop/services";
import { Hono } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { invalidParam, orderNotFound, successResponse } from "../../lib/errors.js";
import {
  findOrderByNo,
  findUserIdByPhoneHash,
  InvalidOrderCursorError,
  listOrders,
} from "../../repositories/orders.js";
import { mapOrderDetail, mapOrderList, UNKNOWN_USER_ID } from "./mappers.js";

export const orderRoutes = new Hono<AppEnv & { Bindings: Env }>();

/**
 * `GET /orders/{orderNo}` —— 订单详情。
 *
 * 主单与子单状态**同时下发**（`docs/08` §8.3）。
 */
orderRoutes.get("/orders/:orderNo", async (c) => {
  const parsed = AgentOrderDetailParamsSchema.safeParse({ orderNo: c.req.param("orderNo") });
  if (!parsed.success) {
    return invalidParam("orderNo 格式非法（须为 ^DS\\d{17}$）");
  }

  const aggregate = await findOrderByNo(c.env.DB, parsed.data.orderNo);
  if (aggregate === null) return orderNotFound(`订单不存在：${parsed.data.orderNo}`);

  // `Cache-Control` / `X-Cache` 由 `withEdgeCache()` 按 `AGENT_ENDPOINTS` 的
  // `cacheTtlSeconds` 统一落头（此前这里硬编码 `no-store`，与 Schema 的 10s 不一致，
  // 见 `docs/M0-字段契约.md` §13.9 第 48 项）。此处不再自行下发缓存头。
  return successResponse(
    maskAgentPayload(AgentOrderDetailSchema, mapOrderDetail(aggregate), "GET /orders/{orderNo}"),
  );
});

/**
 * `GET /orders` —— 用户最近订单列表。
 *
 * `userId` / `phone` **二选一**（`AgentOrderListQuerySchema.superRefine` 已强制）。
 * `phone` 经 `normalizePhone()` + `hashPhone(PHONE_HASH_PEPPER, phone)` 转 `phone_hash`
 * 后查 `users`；**查不到用户返回空列表而非 404**（设计决策，见汇报）。
 */
orderRoutes.get("/orders", async (c) => {
  const parsed = AgentOrderListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return invalidParam("查询参数非法：userId 与 phone 必须二选一（不可同时缺失或同时提供）");
  }
  const query = parsed.data;

  let statuses: string[] | undefined;
  try {
    statuses = parseStatusFilter(query.status);
  } catch (err) {
    return invalidParam(err instanceof Error ? err.message : "status 含非法取值");
  }

  let userId: string;
  if (query.userId !== undefined) {
    userId = query.userId;
  } else {
    const phone = query.phone ?? "";
    const normalized = normalizePhone(phone);
    if (normalized === null) return invalidParam("phone 须为 11 位且以 1 开头");
    const phoneHash = await hashPhone(c.env.PHONE_HASH_PEPPER, normalized);
    const found = await findUserIdByPhoneHash(c.env.DB, phoneHash);
    if (found === null) {
      // 设计决策：查不到用户 → 空列表（非 404），避免暴露「该手机号是否注册」
      return successResponse(
        maskAgentPayload(
          AgentOrderListSchema,
          mapOrderList(UNKNOWN_USER_ID, [], null, false),
          "GET /orders",
        ),
      );
    }
    userId = found;
  }

  let result: Awaited<ReturnType<typeof listOrders>>;
  try {
    result = await listOrders(c.env.DB, {
      userId,
      statuses,
      limit: query.limit,
      cursor: query.cursor,
    });
  } catch (error) {
    /*
     * 畸形游标必须显式报错，**不可**静默降级成「空列表」：
     * 那会让 Agent 把「游标坏了」误读成「该用户没有订单」。
     */
    if (error instanceof InvalidOrderCursorError) {
      return invalidParam("cursor 格式非法（须为 base64url 编码的 <created_at>|<order_no>）");
    }
    throw error;
  }

  return successResponse(
    maskAgentPayload(
      AgentOrderListSchema,
      mapOrderList(userId, result.rows, result.nextCursor, result.hasMore),
      "GET /orders",
    ),
  );
});
