/**
 * DShop Worker 入口（`docs/03` §3.1 / `docs/07` §7.1）。
 *
 * 路由分组：
 * - `/api/v1/agent/*` —— **PiEcho Agent 只读契约六端点**，服务令牌认证，**仅 GET**
 * - `/api/v1/admin/*` —— 后台登录 / RBAC 骨架
 * - `/health`         —— 健康检查（无认证）
 *
 * 中间件链（Agent 组，顺序即语义）：
 * `requestId → contractVersion → accessLog → serviceTokenAuth → requireScope → rateLimit → handler`
 */

import { Hono } from "hono";

import { AgentRateLimiter } from "./durable-objects/agent-rate-limiter.js";
import type { Env } from "./env.js";
import type { AppEnv } from "./lib/context.js";
import { accessLog } from "./middleware/access-log.js";
import { contractVersion } from "./middleware/contract-version.js";
import { requestId } from "./middleware/request-id.js";
import { adminRoutes } from "./routes/admin/index.js";
import { agentRoutes } from "./routes/agent/index.js";

export { AgentRateLimiter };

const app = new Hono<AppEnv & { Bindings: Env }>();

/* -------------------------------------------------------------------------- */
/* 全局中间件                                                                  */
/* -------------------------------------------------------------------------- */

app.use("*", requestId());
app.use("*", contractVersion());
app.use("*", accessLog());

/* -------------------------------------------------------------------------- */
/* 健康检查                                                                    */
/* -------------------------------------------------------------------------- */

app.get("/health", (c) =>
  c.json({ status: "ok", environment: c.env.ENVIRONMENT ?? "unknown" }),
);

/* -------------------------------------------------------------------------- */
/* Agent 组：只读契约                                                          */
/* -------------------------------------------------------------------------- */

// **Agent 组只读**：非 GET 一律 405 + 40501（守卫在 `agentRoutes` 内部，
// 位于鉴权之前，故未带令牌的 POST 也得到 405 而非 401——见该文件注释）。
app.route("/api/v1/agent", agentRoutes);
/* -------------------------------------------------------------------------- */
/* 后台组                                                                      */
/* -------------------------------------------------------------------------- */

app.route("/api/v1/admin", adminRoutes);

/* -------------------------------------------------------------------------- */
/* 兜底                                                                        */
/* -------------------------------------------------------------------------- */

app.notFound((c) => {
  return c.json(
    { code: 40401, message: "资源不存在", data: null },
    404,
  );
});

app.onError((err, c) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "unhandled_error",
      requestId: c.get("requestId") ?? null,
      path: c.req.path,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  return c.json({ code: 50001, message: "服务内部错误", data: null }, 500);
});

export default app;
