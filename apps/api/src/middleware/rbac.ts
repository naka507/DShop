/**
 * RBAC 中间件（`docs/09` §9.2）。
 *
 * - `requirePermission(perm)`：校验当前后台主体是否拥有某权限点
 * - `requireRole(code)`：校验是否拥有某角色
 *
 * 权限点由 `roles.permissions` json 数组承载（**无独立权限表**），
 * 定义见 `@dshop/shared` 的 `PERMISSIONS` / `ROLE_PERMISSIONS`。
 *
 * ⚠️ 商户侧行级隔离（`merchantScope`）不在本文件——它需要读 `merchant_members`，
 * 属数据层职责，见 `apps/api/src/middleware/merchant-scope.ts`（M0 骨架，未启用）。
 */

import { roleHasPermission } from "@dshop/shared";
import type { Permission } from "@dshop/shared";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../lib/context.js";
import { backofficeErrorForPath } from "../lib/errors.js";

/**
 * 要求指定权限点（403；**字符串错误码**，`docs/README.md:34`）。
 *
 * 码值按请求路径取（`ERR_ADMIN_PERMISSION_DENIED` / `ERR_MERCHANT_PERMISSION_DENIED`）。
 */
export const requirePermission =
  (permission: Permission): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const subject = c.get("adminSubject");
    if (subject === undefined) {
      return backofficeErrorForPath(c.req.path, "PERMISSION_DENIED", "未登录");
    }
    // M0：权限点来自 JWT 的 role 字段（单角色）；多角色需查库，属后续迭代
    if (!roleHasPermission(subject.role, permission)) {
      return backofficeErrorForPath(c.req.path, "PERMISSION_DENIED", `缺少权限：${permission}`);
    }
    await next();
  };

/** 要求指定角色。 */
export const requireRole =
  (roleCode: string): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const subject = c.get("adminSubject");
    if (subject === undefined) {
      return backofficeErrorForPath(c.req.path, "PERMISSION_DENIED", "未登录");
    }
    if (subject.role !== roleCode) {
      return backofficeErrorForPath(c.req.path, "PERMISSION_DENIED", `需要角色：${roleCode}`);
    }
    await next();
  };
