/**
 * 商户行级隔离中间件（`docs/09` §9.2）—— **M0 骨架，未挂载到任何路由**。
 *
 * 商户侧后台主体（`aud = merchant`）只能看到自己所属商户的数据。
 * 判定依据：
 * - JWT 载荷的 `mid`（登录时写入的首个商户 id）
 * - `merchant_members` 表中 `status = active` 的关联关系（可多商户）
 *
 * M0 只提供中间件与判定函数，**不挂载**：后台业务端点（商品/订单管理）
 * 属后续里程碑。M0 交付的是「登录 + RBAC 骨架」。
 *
 * 挂载示例（后续里程碑）：
 * ```ts
 * adminRoutes.get("/merchant/products", requireAdminAuth([JWT_AUDIENCE.MERCHANT]), merchantScope(), handler);
 * ```
 */

import { AGENT_ERROR_CODES, JWT_AUDIENCE } from "@dshop/shared";
import type { MiddlewareHandler } from "hono";

import type { Env } from "../env.js";
import type { AppEnv } from "../lib/context.js";
import { errorResponse } from "../lib/errors.js";
import { findMerchantIdsForAdmin } from "../repositories/admin-users.js";

/** 请求上下文中注入的「可见商户集合」。 */
export interface MerchantScope {
  /** 平台侧主体：可见全部商户。 */
  readonly all: boolean;
  /** 商户侧主体：可见的商户 id 集合。 */
  readonly merchantIds: readonly string[];
}

/**
 * 判定当前主体是否可访问指定商户的数据。
 *
 * 平台侧（`all = true`）放行；商户侧必须命中 `merchantIds`。
 */
export function canAccessMerchant(scope: MerchantScope, merchantId: string): boolean {
  return scope.all || scope.merchantIds.includes(merchantId);
}

/**
 * 要求商户侧主体，并解析其可见商户集合。
 *
 * 平台侧主体（`aud = admin`）也会被放行，但 `all = true`。
 * 未知 `aud` → 403。
 */
export const merchantScope = (): MiddlewareHandler<AppEnv & { Bindings: Env }> => async (
  c,
  next,
) => {
  const subject = c.get("adminSubject");
  if (subject === undefined) {
    return errorResponse(AGENT_ERROR_CODES.TOKEN_MISSING_OR_INVALID, "未登录");
  }

  if (subject.aud === JWT_AUDIENCE.ADMIN) {
    // 平台侧：可见全部（实际是否放行由更上层的 RBAC 权限点决定）
    await next();
    return;
  }

  if (subject.aud !== JWT_AUDIENCE.MERCHANT) {
    return errorResponse(AGENT_ERROR_CODES.SCOPE_INSUFFICIENT, "主体类型不支持商户数据");
  }

  const merchantIds = await findMerchantIdsForAdmin(c.env.DB, subject.sub);
  if (merchantIds.length === 0) {
    return errorResponse(AGENT_ERROR_CODES.SCOPE_INSUFFICIENT, "未关联任何商户");
  }

  await next();
};

/** 从上下文组装商户可见范围（供 handler 调用）。 */
export async function resolveMerchantScope(
  db: D1Database,
  subject: { aud: string; sub: string },
): Promise<MerchantScope> {
  if (subject.aud === JWT_AUDIENCE.ADMIN) {
    return { all: true, merchantIds: [] };
  }
  return { all: false, merchantIds: await findMerchantIdsForAdmin(db, subject.sub) };
}
