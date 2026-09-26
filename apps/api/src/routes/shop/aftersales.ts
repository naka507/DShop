/**
 * C 端售后路由（`docs/06` §6 的 `/api/v1/shop/aftersales*`，`docs/08` §8.4）。
 *
 * - `POST /aftersales`               —— 申请售后（**必须**带 `Idempotency-Key`）
 * - `GET  /aftersales`               —— 列表
 * - `GET  /aftersales/:aftersaleNo`  —— 详情（时间线取 `aftersale_logs`）
 *
 * ## 归属校验（`SHOP_ERROR_CODES.AFTERSALE_NOT_FOUND` 的语义注释）
 *
 * 「售后单不存在**或不属于当前用户**」——两者**不区分**，统一 `404` +
 * `ERR_SHOP_AFTERSALE_NOT_FOUND`，防枚举（不能用 403，那会泄露「该单存在」）。
 * 归属判据写在 SQL 的 `WHERE user_id = ?` 里，不靠应用层比对。
 *
 * ## 申请售后的链路（`docs/08` §8.4）
 *
 * `PENDING_MERCHANT`（初始）→ 商家处理 → …… → `REFUNDED`。
 * 本端点只负责**建单 + 写首条时间线**；后续流转属商户后台与平台介入。
 */

import {
  ShopAftersaleApplyBodySchema,
  ShopAftersaleDetailSchema,
  ShopAftersaleListQuerySchema,
  ShopAftersaleListSchema,
  ShopAftersaleParamsSchema,
  SUB_ORDER_STATUS,
  formatAftersaleNo,
  newId,
} from "@dshop/shared";
import { Hono } from "hono";
import type { Context } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { successResponse } from "../../lib/errors.js";
import {
  findAftersaleApplyTarget,
  findShopAftersaleByNo,
  insertShopAftersale,
  listShopAftersales,
} from "../../repositories/shop-aftersales.js";
import {
  IDEMPOTENCY_SCOPE,
  beginIdempotentRequest,
  completeIdempotentRequest,
  requestFingerprintOf,
} from "../../repositories/shop-idempotency.js";
import { nextAftersaleSeq } from "../../repositories/shop-orders.js";
import { shopError, shopInvalidParam } from "./errors.js";
import { requireShopAuth } from "./guard.js";
import { mapAftersaleDetail, mapAftersaleListItem } from "./mappers.js";

export const aftersaleRoutes = new Hono<AppEnv & { Bindings: Env }>();

/** 取当前登录用户 id。 */
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

/* -------------------------------------------------------------------------- */
/* 申请                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `POST /aftersales` —— 申请售后（仅退款 / 退货退款 + 凭证）。
 *
 * ⚠️ `Idempotency-Key` **必须**携带（与 `POST /shop/orders` 同纪律，`docs/06` §6）：
 * 售后申请重复提交会产生两条待处理工单，对商家是**可感知的运营噪音**。
 * 重放直接返回首次结果；同 key 不同请求体 → `ERR_SHOP_IDEMPOTENCY_CONFLICT`。
 */
aftersaleRoutes.post("/aftersales", requireShopAuth(), async (c) => {
  const userId = currentUserId(c);

  // ① 幂等键（与下单同一套机制，只是 scope 不同）
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
    return shopInvalidParam("缺少 Idempotency-Key 请求头");
  }

  const raw = await readJson(c);
  if (raw === null) return shopInvalidParam("请求体不是合法 JSON");

  const body = ShopAftersaleApplyBodySchema.safeParse(raw);
  if (!body.success) return shopInvalidParam("售后申请参数非法");

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const outcome = await beginIdempotentRequest<unknown>(c.env.DB, {
    scope: IDEMPOTENCY_SCOPE.SHOP_AFTERSALE_CREATE,
    key: idempotencyKey,
    requestHash: requestFingerprintOf(body.data),
    newId: newId(),
    nowMs,
  });

  if (outcome.kind === "conflict") {
    return shopError("IDEMPOTENCY_CONFLICT", outcome.reason);
  }
  if (outcome.kind === "replay") {
    const replayed = ShopAftersaleDetailSchema.safeParse(outcome.response);
    if (!replayed.success) {
      return shopError("INTERNAL_ERROR", "幂等重放的首次结果不符合契约");
    }
    return successResponse(replayed.data);
  }

  // ② 归属 + 商品校验（一条 SQL 判定，不信任请求体里的任何归属字段）
  const target = await findAftersaleApplyTarget(c.env.DB, {
    userId,
    orderNo: body.data.orderNo,
    subOrderNo: body.data.subOrderNo,
    skuId: body.data.skuId,
  });
  if (target === null) {
    return shopError("ORDER_NOT_FOUND", "订单或订单商品不存在，或不属于当前用户");
  }

  // 已取消的子单不可申请售后（`docs/08` §8.3 状态机）
  if (target.subOrderStatus === SUB_ORDER_STATUS.CANCELLED) {
    return shopError("ORDER_STATE_CONFLICT", "该子单已取消，无法申请售后");
  }

  // 申请数量不得超过下单数量（防超退）
  if (body.data.quantity > target.quantity) {
    return shopInvalidParam(`申请数量不得超过下单数量 ${target.quantity}`);
  }

  // ③ 建单（`DB.batch()` 原子写 aftersales + 首条 aftersale_logs）
  const aftersaleId = newId();
  const aftersaleNo = formatAftersaleNo(
    new Date(nowMs),
    await nextAftersaleSeq(c.env.DB, aftersaleNoPrefix(nowMs)),
  );

  await insertShopAftersale(c.env.DB, {
    id: aftersaleId,
    aftersaleNo,
    orderId: target.orderId,
    subOrderId: target.subOrderId,
    userId,
    skuId: body.data.skuId,
    itemTitle: target.title,
    quantity: body.data.quantity,
    type: body.data.type,
    reason: body.data.reason,
    evidenceUrls: evidenceUrlsJson(body.data.evidenceKeys),
    // 退款金额 = 下单快照单价 × 申请数量（快照价是**固化价**，不回查商品表）
    refundAmount: target.unitPrice * body.data.quantity,
    nowIso,
  });

  // ④ 取回并下发（归属校验同样在 SQL 里）
  const aggregate = await findShopAftersaleByNo(c.env.DB, userId, aftersaleNo);
  if (aggregate === null) return shopError("INTERNAL_ERROR", "售后建单成功但查不到该单");

  const detail = ShopAftersaleDetailSchema.safeParse(mapAftersaleDetail(aggregate));
  if (!detail.success) return shopError("INTERNAL_ERROR", "售后详情响应不符合契约");

  await completeIdempotentRequest(c.env.DB, {
    scope: IDEMPOTENCY_SCOPE.SHOP_AFTERSALE_CREATE,
    key: idempotencyKey,
    responseBody: JSON.stringify(detail.data),
  });

  return successResponse(detail.data);
});

/* -------------------------------------------------------------------------- */
/* 读                                                                          */
/* -------------------------------------------------------------------------- */

/** `GET /aftersales` —— 售后列表（后台组统一分页 `{ page, pageSize, total, list }`）。 */
aftersaleRoutes.get("/aftersales", requireShopAuth(), async (c) => {
  const parsed = ShopAftersaleListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return shopInvalidParam("查询参数非法（status / page / pageSize）");

  const userId = currentUserId(c);
  const result = await listShopAftersales(c.env.DB, {
    userId,
    status: parsed.data.status,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });

  const validated = ShopAftersaleListSchema.safeParse({
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    total: result.total,
    list: result.rows.map(mapAftersaleListItem),
  });
  if (!validated.success) return shopError("INTERNAL_ERROR", "售后列表响应不符合契约");

  return successResponse(validated.data);
});

/**
 * `GET /aftersales/:aftersaleNo` —— 售后详情。
 *
 * `timeline` 的唯一来源是 `aftersale_logs`（`docs/08` §8.4：
 * 「每一次状态流转都必须写这条日志」）。
 */
aftersaleRoutes.get("/aftersales/:aftersaleNo", requireShopAuth(), async (c) => {
  const parsed = ShopAftersaleParamsSchema.safeParse({
    aftersaleNo: c.req.param("aftersaleNo"),
  });
  if (!parsed.success) return shopInvalidParam("aftersaleNo 格式非法（须为 ^AS\\d{11}$）");

  const userId = currentUserId(c);
  const aggregate = await findShopAftersaleByNo(c.env.DB, userId, parsed.data.aftersaleNo);
  if (aggregate === null) {
    return shopError("AFTERSALE_NOT_FOUND", "售后单不存在或不属于当前用户");
  }

  const validated = ShopAftersaleDetailSchema.safeParse(mapAftersaleDetail(aggregate));
  if (!validated.success) return shopError("INTERNAL_ERROR", "售后详情响应不符合契约");

  return successResponse(validated.data);
});

/* -------------------------------------------------------------------------- */
/* 内部                                                                        */
/* -------------------------------------------------------------------------- */

/** 售后单号前缀（`AS` + UTC+8 的 `YYYYMMDD`），用于当日序列查询。 */
function aftersaleNoPrefix(nowMs: number): string {
  return formatAftersaleNo(new Date(nowMs), 1).slice(0, 10);
}

/**
 * 凭证对象键 → `evidence_urls` 列的 JSON 串。
 *
 * ⚠️ 契约只下发**数量**（`ShopAftersaleDetailSchema.evidenceCount`），
 * 原文永不进入响应；这里只做「数组 → JSON 字符串」的落库转换。
 */
function evidenceUrlsJson(keys: readonly string[] | undefined): string {
  if (keys === undefined || keys.length === 0) return "[]";
  return JSON.stringify(keys.filter((key) => typeof key === "string" && key.length > 0));
}
