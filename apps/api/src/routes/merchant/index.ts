/**
 * 商户后台路由组（`/api/v1/merchant/*`，`docs/06` §6）。
 *
 * ## 端点清单（严格对齐 `MERCHANT_ENDPOINTS`，12 条）
 *
 * | 方法 | 路径 | 行级隔离 |
 * | --- | --- | --- |
 * | POST | `/merchant/login` | — |
 * | POST | `/merchant/refresh` | — |
 * | POST | `/merchant/logout` | — |
 * | GET | `/merchant/me` | 需登录（只接受 `aud = merchant`） |
 * | GET | `/merchant/orders` | ★ 商户隔离 |
 * | GET | `/merchant/orders/:orderNo` | ★ 商户隔离 |
 * | GET | `/merchant/aftersales` | ★ 商户隔离 |
 * | GET | `/merchant/aftersales/:aftersaleNo` | ★ 商户隔离 |
 * | GET | `/merchant/products` | ★ 商户隔离 |
 * | GET | `/merchant/categories` | 平台级共享字典（不过滤） |
 * | GET | `/merchant/merchants` | ★ 商户隔离（商户侧只看自己） |
 * | GET | `/merchant/stores` | ★ 商户隔离 |
 *
 * ## 挂载路径（供 `src/index.ts` 使用）
 *
 * ```ts
 * app.route("/api/v1/merchant", merchantRoutes);
 * ```
 */

import { Hono } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { merchantAuthRoutes } from "./auth.js";
import { merchantBusinessRoutes } from "./business.js";

export const merchantRoutes = new Hono<AppEnv & { Bindings: Env }>();

// 会话四端点（login / refresh / logout / me）
merchantRoutes.route("/", merchantAuthRoutes);
// 业务六组端点（orders / aftersales / products / categories / merchants / stores）
merchantRoutes.route("/", merchantBusinessRoutes);

/** 已登记的端点路径模板（契约测试用；应逐字等于 `MERCHANT_ENDPOINTS[].path`）。 */
export const REGISTERED_MERCHANT_PATHS: readonly string[] = [
  "/merchant/login",
  "/merchant/refresh",
  "/merchant/logout",
  "/merchant/me",
  "/merchant/orders",
  "/merchant/orders/:orderNo",
  "/merchant/aftersales",
  "/merchant/aftersales/:aftersaleNo",
  "/merchant/products",
  "/merchant/categories",
  "/merchant/merchants",
  "/merchant/stores",
];
