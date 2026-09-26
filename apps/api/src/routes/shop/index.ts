/**
 * C 端商城路由组（`/api/v1/shop/*`，`docs/06` §6）。
 *
 * ## 挂载方式（由 `apps/api/src/index.ts` 调用）
 *
 * ```ts
 * app.route("/api/v1/shop", shopRoutes);
 * ```
 *
 * ## 鉴权边界（`docs/09` §9.1）
 *
 * `/api/v1/shop` 下**既有公开端点也有受保护端点**，因此
 * `requireShopAuth()` **不能**无差别挂在整组上——否则 `/shop/products`
 * 这类公开浏览端点也会要求登录。本实现采用「**受保护路由各自挂中间件**」：
 *
 * | 路由模块 | 端点 | 鉴权 |
 * | --- | --- | --- |
 * | `catalogRoutes` | `/products`、`/categories`、`/products/:spuId` | 公开 |
 * | `authRoutes` | `/auth/sms-code`、`/auth/login` | **公开**（登录前无凭据） |
 * | `authRoutes` | `/auth/logout`、`/auth/me`、`/addresses` | 需登录 |
 * | `cartRoutes` | `/cart*`、`/checkout/preview` | 需登录 |
 * | `orderRoutes` | `/orders*` | 需登录 |
 * | `aftersaleRoutes` | `/aftersales*` | 需登录 |
 *
 * 中间件写在**各自的 `routes.<method>(path, requireShopAuth(), handler)`** 里，
 * 而不是在组级 `use("*")` 上按路径白名单排除——后者一旦漏写一个公开路径就会
 * 把浏览端点锁死，且新增端点时容易忘记加白名单。
 *
 * ## 错误码分层（`docs/README.md` 的「错误码」条目）
 *
 * 本组**全部**返回字符串码 `ERR_SHOP_*`（`SHOP_ERROR_CODES`），
 * 与 Agent 组的整数码严格分离。未知路径的 404 由 `apps/api/src/index.ts`
 * 的全局 `notFound` 按路径前缀取表得到 `ERR_SHOP_NOT_FOUND`。
 */

import { Hono } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { aftersaleRoutes } from "./aftersales.js";
import { authRoutes } from "./auth.js";
import { cartRoutes } from "./cart.js";
import { catalogRoutes } from "./catalog.js";
import { orderRoutes } from "./orders.js";

export const shopRoutes = new Hono<AppEnv & { Bindings: Env }>();

/* 四个子路由全部挂在根路径 `/`，各自的完整路径在模块内声明
 * （如 `catalogRoutes` 的 `/products` → `/api/v1/shop/products`）。 */
shopRoutes.route("/", catalogRoutes);
shopRoutes.route("/", authRoutes);
shopRoutes.route("/", cartRoutes);
shopRoutes.route("/", orderRoutes);
shopRoutes.route("/", aftersaleRoutes);

/* -------------------------------------------------------------------------- */
/* 契约自检：端点清单与子路由一一对应                                            */
/* -------------------------------------------------------------------------- */

/**
 * 已登记的 shop 端点（**方法 + 相对路径**），应逐字等于
 * `@dshop/shared` 的 `SHOP_ENDPOINT_LIST`。
 *
 * ⚠️ 这里**手动登记**而非从 `SHOP_ENDPOINT_LIST` 生成：Hono 的路由注册是
 * 编译期的显式调用（`get("/products", ...)`），无法从运行时清单反射生成。
 * 该常量供测试断言「20 个端点全部已实现、无遗漏」，是**防止漏实现**的护栏。
 */
export const REGISTERED_SHOP_ENDPOINTS: readonly {
  readonly method: string;
  readonly path: string;
}[] = [
  { method: "GET", path: "/shop/products" },
  { method: "GET", path: "/shop/categories" },
  { method: "GET", path: "/shop/products/:spuId" },
  { method: "GET", path: "/shop/cart" },
  { method: "POST", path: "/shop/cart/items" },
  { method: "PUT", path: "/shop/cart/items/:id" },
  { method: "DELETE", path: "/shop/cart/items/:id" },
  { method: "GET", path: "/shop/checkout/preview" },
  { method: "GET", path: "/shop/addresses" },
  { method: "POST", path: "/shop/orders" },
  { method: "POST", path: "/shop/orders/:orderNo/pay" },
  { method: "GET", path: "/shop/orders" },
  { method: "GET", path: "/shop/orders/:orderNo" },
  { method: "POST", path: "/shop/aftersales" },
  { method: "GET", path: "/shop/aftersales" },
  { method: "GET", path: "/shop/aftersales/:aftersaleNo" },
  { method: "POST", path: "/shop/auth/sms-code" },
  { method: "POST", path: "/shop/auth/login" },
  { method: "POST", path: "/shop/auth/logout" },
  { method: "GET", path: "/shop/auth/me" },
];
