/**
 * 商户后台业务路由（`docs/06` §6 的 `/api/v1/merchant/*`）。
 *
 * ## 中间件链（`docs/06:53`）
 *
 * `requireAdminAuth([admin, merchant])` → `merchantScope()` → handler
 *
 * ⚠️ **两条链路的 `aud` 策略不同**（`docs/09` §9.1 的 `aud` 强隔离）：
 *
 * - **业务端点**（orders / aftersales / products / categories / merchants / stores）：
 *   按 `merchant-scope.ts` 的设计接受 `aud ∈ {admin, merchant}`——
 *   平台侧 `scope.all = true`，可读全部（`docs/09` §9.2 的平台侧视角）；
 *   商户侧被强制收敛到自己的 `merchant_id`。
 * - **`/merchant/me`**（在 `auth.ts` 内）只接受 `merchant`。
 *
 * ## 行级隔离的强制点
 *
 * 隔离**不在路由层**：路由只调 `resolveMerchantScope()` 取可见集合，
 * 真正注入 `merchant_id = ?` 的位置是 `repositories/merchant-*.ts` 的 SQL。
 * 路由**从不读取**请求里的 `merchantId` 参数。
 */

import {
  MERCHANT_ERROR_CODES,
  MerchantAftersaleListQuerySchema,
  MerchantOrderListQuerySchema,
  MerchantProductListQuerySchema,
  PageQuerySchema,
} from "@dshop/shared";
import { Hono } from "hono";
import type { Context } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { backofficeErrorResponse, successResponse } from "../../lib/errors.js";
import { requireMerchantAuth } from "./guards.js";
import { merchantScope, resolveMerchantScope } from "../../middleware/merchant-scope.js";
import {
  findMerchantAftersaleByNo,
  listMerchantAftersales,
} from "../../repositories/merchant-aftersales.js";
import {
  listMerchantCategories,
  listMerchantMerchants,
  listMerchantProducts,
  listMerchantStores,
} from "../../repositories/merchant-catalog.js";
import { findMerchantOrderByNo, listMerchantOrders } from "../../repositories/merchant-orders.js";
import {
  mapAftersaleDetail,
  mapAftersaleSummaryItem,
  mapCategory,
  mapMerchant,
  mapOrderDetail,
  mapOrderSummary,
  mapProduct,
  mapStore,
} from "./mappers.js";

export const merchantBusinessRoutes = new Hono<AppEnv & { Bindings: Env }>();

/* -------------------------------------------------------------------------- */
/* 组级中间件                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * 平台侧（`aud = admin`）也放行：`merchantScope()` 会把它标为 `all = true`，
 * 语义即 `docs/09` §9.2 的「平台侧可见全部商户」；商户侧则被收敛到自己的 `merchant_id`。
 * 未登录统一返回 `ERR_MERCHANT_UNAUTHORIZED`（`guards.ts` 说明为何不复用共享中间件）。
 */
/*
 * ⚠️ 中间件**逐路由挂载**，而不是组级 `use("*", ...)`。
 *
 * 组级通配会把**未登记的路径**也先拦成 401（`ERR_MERCHANT_UNAUTHORIZED`），
 * 使未知路径永远拿不到本域的 404 —— 而未知路径的 404 是由
 * `apps/api/src/index.ts` 的全局 `notFound` 按路径前缀查表得出的
 * `ERR_MERCHANT_NOT_FOUND`（`docs/README.md` 错误码条目）。
 * `shop/index.ts` 的模块头注释记录了同样的取舍，此处保持一致。
 */

/** 取当前请求的可见商户范围（handler 共用；**不含任何请求参数**）。 */
async function scopeOf(c: Context<AppEnv & { Bindings: Env }>) {
  return await resolveMerchantScope(c.env.DB, c.get("adminSubject"));
}

/** 统一的分页查询解析（`docs/06` §6：`{ page, pageSize, total, list }`）。 */
function parsePage(
  query: Record<string, string | undefined>,
): { page: number; pageSize: number } | null {
  const parsed = PageQuerySchema.safeParse(query);
  return parsed.success ? { page: parsed.data.page, pageSize: parsed.data.pageSize } : null;
}

/** 分页信封（`docs/06` §6 的后台三组统一形状）。 */
function pageEnvelope<T>(
  page: number,
  pageSize: number,
  total: number,
  list: readonly T[],
): { page: number; pageSize: number; total: number; list: readonly T[] } {
  return { page, pageSize, total, list };
}

/* -------------------------------------------------------------------------- */
/* GET /merchant/orders                                                        */
/* -------------------------------------------------------------------------- */

merchantBusinessRoutes.get("/orders", requireMerchantAuth(), merchantScope(), async (c) => {
  const page = parsePage(c.req.query());
  if (page === null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.INVALID_PARAM, "分页参数非法");
  }
  const parsed = MerchantOrderListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return backofficeErrorResponse(
      MERCHANT_ERROR_CODES.INVALID_PARAM,
      parsed.error.issues[0]?.message ?? "查询参数非法",
    );
  }

  const scope = await scopeOf(c);
  const result = await listMerchantOrders(c.env.DB, {
    scope,
    status: parsed.data.status,
    orderNo: parsed.data.orderNo,
    page: page.page,
    pageSize: page.pageSize,
  });

  return successResponse(
    pageEnvelope(page.page, page.pageSize, result.total, result.rows.map(mapOrderSummary)),
  );
});

/* -------------------------------------------------------------------------- */
/* GET /merchant/orders/:orderNo                                               */
/* -------------------------------------------------------------------------- */

merchantBusinessRoutes.get(
  "/orders/:orderNo",
  requireMerchantAuth(),
  merchantScope(),
  async (c) => {
    const scope = await scopeOf(c);
    const aggregate = await findMerchantOrderByNo(c.env.DB, scope, c.req.param("orderNo"));
    /*
     * 不属于当前商户的订单与不存在的订单**返回同一个 404**（`docs/09` §9.2 的
     * 防枚举口径）：不区分「不存在」与「无权访问」，避免用状态码探测订单存在性。
     */
    if (aggregate === null) {
      return backofficeErrorResponse(MERCHANT_ERROR_CODES.ORDER_NOT_FOUND, "订单不存在");
    }
    return successResponse(mapOrderDetail(aggregate));
  },
);

/* -------------------------------------------------------------------------- */
/* GET /merchant/aftersales                                                    */
/* -------------------------------------------------------------------------- */

merchantBusinessRoutes.get("/aftersales", requireMerchantAuth(), merchantScope(), async (c) => {
  const page = parsePage(c.req.query());
  if (page === null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.INVALID_PARAM, "分页参数非法");
  }
  const parsed = MerchantAftersaleListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return backofficeErrorResponse(
      MERCHANT_ERROR_CODES.INVALID_PARAM,
      parsed.error.issues[0]?.message ?? "查询参数非法",
    );
  }

  const scope = await scopeOf(c);
  const result = await listMerchantAftersales(c.env.DB, {
    scope,
    status: parsed.data.status,
    page: page.page,
    pageSize: page.pageSize,
  });

  return successResponse(
    pageEnvelope(page.page, page.pageSize, result.total, result.rows.map(mapAftersaleSummaryItem)),
  );
});

/* -------------------------------------------------------------------------- */
/* GET /merchant/aftersales/:aftersaleNo                                       */
/* -------------------------------------------------------------------------- */

merchantBusinessRoutes.get(
  "/aftersales/:aftersaleNo",
  requireMerchantAuth(),
  merchantScope(),
  async (c) => {
    const scope = await scopeOf(c);
    const aggregate = await findMerchantAftersaleByNo(c.env.DB, scope, c.req.param("aftersaleNo"));
    // 同 `/orders/:orderNo`：不存在与无权访问共用一个 404
    if (aggregate === null) {
      return backofficeErrorResponse(MERCHANT_ERROR_CODES.AFTERSALE_NOT_FOUND, "售后单不存在");
    }
    return successResponse(mapAftersaleDetail(aggregate));
  },
);

/* -------------------------------------------------------------------------- */
/* GET /merchant/products                                                      */
/* -------------------------------------------------------------------------- */

merchantBusinessRoutes.get("/products", requireMerchantAuth(), merchantScope(), async (c) => {
  const page = parsePage(c.req.query());
  if (page === null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.INVALID_PARAM, "分页参数非法");
  }
  const parsed = MerchantProductListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return backofficeErrorResponse(
      MERCHANT_ERROR_CODES.INVALID_PARAM,
      parsed.error.issues[0]?.message ?? "查询参数非法",
    );
  }

  const scope = await scopeOf(c);
  const result = await listMerchantProducts(c.env.DB, {
    scope,
    status: parsed.data.status,
    q: parsed.data.q,
    categoryId: parsed.data.categoryId,
    page: page.page,
    pageSize: page.pageSize,
  });

  return successResponse(
    pageEnvelope(page.page, page.pageSize, result.total, result.rows.map(mapProduct)),
  );
});

/* -------------------------------------------------------------------------- */
/* GET /merchant/categories                                                    */
/* -------------------------------------------------------------------------- */

merchantBusinessRoutes.get("/categories", requireMerchantAuth(), merchantScope(), async (c) => {
  const page = parsePage(c.req.query());
  if (page === null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.INVALID_PARAM, "分页参数非法");
  }
  /*
   * 类目是**平台级共享字典**（`MERCHANT_ENDPOINTS.CATEGORIES.merchantScoped = false`，
   * `categories` 表无 `merchant_id` 列），故不做商户过滤——
   * 但仍需通过鉴权（未登录返回 `ERR_MERCHANT_UNAUTHORIZED`）。
   */
  const result = await listMerchantCategories(c.env.DB, {
    page: page.page,
    pageSize: page.pageSize,
  });

  return successResponse(
    pageEnvelope(page.page, page.pageSize, result.total, result.rows.map(mapCategory)),
  );
});

/* -------------------------------------------------------------------------- */
/* GET /merchant/merchants                                                     */
/* -------------------------------------------------------------------------- */

merchantBusinessRoutes.get("/merchants", requireMerchantAuth(), merchantScope(), async (c) => {
  const page = parsePage(c.req.query());
  if (page === null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.INVALID_PARAM, "分页参数非法");
  }
  const scope = await scopeOf(c);
  const result = await listMerchantMerchants(c.env.DB, {
    scope,
    page: page.page,
    pageSize: page.pageSize,
  });

  return successResponse(
    pageEnvelope(page.page, page.pageSize, result.total, result.rows.map(mapMerchant)),
  );
});

/* -------------------------------------------------------------------------- */
/* GET /merchant/stores                                                        */
/* -------------------------------------------------------------------------- */

merchantBusinessRoutes.get("/stores", requireMerchantAuth(), merchantScope(), async (c) => {
  const page = parsePage(c.req.query());
  if (page === null) {
    return backofficeErrorResponse(MERCHANT_ERROR_CODES.INVALID_PARAM, "分页参数非法");
  }
  const scope = await scopeOf(c);
  const result = await listMerchantStores(c.env.DB, {
    scope,
    page: page.page,
    pageSize: page.pageSize,
  });

  return successResponse(
    pageEnvelope(page.page, page.pageSize, result.total, result.rows.map(mapStore)),
  );
});
