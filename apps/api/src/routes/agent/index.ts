/**
 * Agent 只读契约路由组（`docs/07` §7.2–§7.7、§7.8.3）。
 *
 * 挂载顺序（**每个端点都按此顺序串**）：
 * `serviceTokenAuth()` → `requireScope(<该端点 scope>)` → `rateLimit()` → handler
 *
 * 另加两道只读保证：
 * 1. 组级 `use("*")` —— 任何非 GET 方法在**鉴权之前**即返回 `405` + `40501` + `Allow: GET`
 *    （早于鉴权，避免用写方法探测令牌有效性）
 * 2. 组级 `all("*")` 兜底 —— 已登记路径之外的请求：非 GET → 405，GET → 交由上层 404
 *
 * 还有一道 `endpointTemplate` 注入中间件：让限流中间件能查到端点级配额
 * （`endpointSpec(c.get("endpointTemplate"))`）。
 *
 * ⚠️ Agent 组**只挂 GET**；写 scope 一期不签发（`docs/07` §7.12）。
 */

import { AGENT_ENDPOINTS } from "@dshop/shared";
import { Hono } from "hono";

import type { Env } from "../../env.js";
import type { AppEnv } from "../../lib/context.js";
import { methodNotAllowed } from "../../lib/errors.js";
import { rateLimit } from "../../middleware/rate-limit.js";
import { requireScope } from "../../middleware/scope.js";
import { serviceTokenAuth } from "../../middleware/service-token-auth.js";
import { aftersaleRoutes } from "./aftersales.js";
import { orderRoutes } from "./orders.js";
import { productRoutes } from "./products.js";

export const agentRoutes = new Hono<AppEnv & { Bindings: Env }>();

/** 端点模板 → 该端点规格（scope / 限流）。 */
const specByPath = new Map(AGENT_ENDPOINTS.map((spec) => [spec.path, spec]));

/* -------------------------------------------------------------------------- */
/* 只读保证第一道：非 GET 在鉴权前直接 405                                       */
/* -------------------------------------------------------------------------- */

agentRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") return methodNotAllowed("Agent 组只允许 GET");
  await next();
});

/*
 * 只读保证第二道：服务令牌认证。
 *
 * ⚠️ 必须挂在 405 守卫**之后**——否则无令牌的 POST 会先撞 401，
 * 破坏「非 GET 一律 405、不泄露令牌有效性」的语义（`docs/07` §7.8.1）。
 * 该中间件挂在组内（而非 `src/index.ts` 编排层），以保证鉴权与 405 的
 * 先后顺序不依赖调用方；生产入口与测试共用同一条链。
 */
agentRoutes.use("*", serviceTokenAuth());

/* -------------------------------------------------------------------------- */
/* 三个子路由按 `AGENT_ENDPOINTS` 的路径逐个挂载并串中间件                        */
/* -------------------------------------------------------------------------- */

for (const spec of AGENT_ENDPOINTS) {
  agentRoutes.use(spec.path, async (c, next) => {
    c.set("endpointTemplate", spec.path);
    await next();
  });
  agentRoutes.use(spec.path, requireScope(spec.scope as Parameters<typeof requireScope>[0]));
  agentRoutes.use(spec.path, rateLimit());
}

agentRoutes.route("/", orderRoutes);
agentRoutes.route("/", productRoutes);
agentRoutes.route("/", aftersaleRoutes);

/* -------------------------------------------------------------------------- */
/* 只读保证第二道：兜底                                                          */
/* -------------------------------------------------------------------------- */

agentRoutes.all("*", (c) =>
  c.req.method === "GET" ? c.notFound() : methodNotAllowed("Agent 组只允许 GET"),
);

/** 已登记的端点路径集合（应逐字等于 `AGENT_ENDPOINTS` 的 `path`）。 */
export const REGISTERED_AGENT_PATHS: readonly string[] = [...specByPath.keys()];
