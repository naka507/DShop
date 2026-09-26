/**
 * DShop Worker 入口（`docs/03` §3.1 / `docs/07` §7.1）。
 *
 * 路由分组：
 * - `/api/v1/agent/*` —— **PiEcho Agent 只读契约六端点**，服务令牌认证，**仅 GET**
 * - `/api/v1/admin/*` —— 后台登录 / RBAC 骨架 / PiEcho 运营三入口
 * - `/health`         —— 健康检查（无认证）
 *
 * 中间件链（Agent 组，顺序即语义）：
 * `requestId → contractVersion → accessLog → agentAudit → (405 守卫 → serviceTokenAuth
 *  → requireScope → rateLimit) → handler`
 *
 * ⚠️ `agentAudit` 挂在 `accessLog` **之后**（`docs/06:53` 的链序）。
 * 它在 `await next()` 之后采集，故 `serviceTokenAuth` / 状态码均可用，
 * 语义上等价于「挂在鉴权之后」，同时额外覆盖 401/403/405/429 这些
 * 未进入 handler 的调用（`docs/07` §7.11 的「可用性」与「限流拒绝率」正需要它们）。
 *
 * ## 错误码按路径前缀分流（**必须**，`docs/README.md:34` / `docs/06:20`）
 *
 * 两组契约并存，故全局兜底也要分流：
 * - `/api/v1/agent/*` → **整数码**（`40401` / `50001`，07 §7.1）
 * - 其余（shop / admin / merchant）→ **字符串码**（`ERR_<域>_NOT_FOUND` / `ERR_<域>_INTERNAL_ERROR`）
 *
 * ## Cron（`docs/08:110-111`）
 *
 * `export default { fetch, scheduled }` —— `scheduled` 由 `apps/api/src/jobs/index.ts` 提供，
 * 触发器配置**在 `wrangler.jsonc` 的 `triggers.crons`**（单一入口每分钟，内部分发任务类型）。
 */

import { AGENT_ERROR_CODES, backofficeErrorCodesForPath, isAgentPath } from "@dshop/shared";
import { Hono } from "hono";

import { AgentRateLimiter } from "./durable-objects/agent-rate-limiter.js";
import type { Env } from "./env.js";
import { queue, scheduled } from "./jobs/index.js";
import type { AppEnv } from "./lib/context.js";
import { backofficeErrorResponse } from "./lib/errors.js";
import { accessLog } from "./middleware/access-log.js";
import { agentAudit } from "./middleware/agent-audit.js";
import { contractVersion } from "./middleware/contract-version.js";
import { requestId } from "./middleware/request-id.js";
import { adminRoutes } from "./routes/admin/index.js";
import { agentRoutes } from "./routes/agent/index.js";
import { callbackRoutes } from "./routes/callbacks/index.js";
import { merchantRoutes } from "./routes/merchant/index.js";
import { shopRoutes } from "./routes/shop/index.js";

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

app.get("/health", (c) => c.json({ status: "ok", environment: c.env.ENVIRONMENT ?? "unknown" }));

/* -------------------------------------------------------------------------- */
/* Agent 组：只读契约 + 审计                                                    */
/* -------------------------------------------------------------------------- */

// `agentAudit` 先于 `agentRoutes` 挂载：记录最终状态码，覆盖鉴权失败与限流拒绝
// （`docs/06:57`：Agent 组额外中间件 `agentReadOnlyGuard` 与 `agentAudit`）。
app.use("/api/v1/agent/*", agentAudit());

// **Agent 组只读**：非 GET 一律 405 + 40501（守卫在 `agentRoutes` 内部，
// 位于鉴权之前，故未带令牌的 POST 也得到 405 而非 401——见该文件注释）。
app.route("/api/v1/agent", agentRoutes);

/* -------------------------------------------------------------------------- */
/* 后台组（admin）与其余三个命名空间                                            */
/* -------------------------------------------------------------------------- */

app.route("/api/v1/admin", adminRoutes);

// C 端：公开浏览（商品/分类）无需登录，受保护端点各自挂 `requireShopAuth`
// （见 `routes/shop/index.ts` 的注释——**不在这一层全局挂鉴权**，否则
// `/shop/products` 这类公开端点也会被拦成 401）。
app.route("/api/v1/shop", shopRoutes);

// 商户后台：行级隔离在 `repositories/merchant-scope-sql.ts` 的 SQL 层强制注入
// `merchant_id`（`docs/09` §9.2），**不依赖前端传参**。
app.route("/api/v1/merchant", merchantRoutes);

// 支付回调：**无鉴权**（`docs/06` §6），靠渠道验签 + `channel_trade_no` 唯一约束幂等。
app.route("/api/v1/callbacks", callbackRoutes);

/* -------------------------------------------------------------------------- */
/* 兜底：按路径前缀分流两套错误码                                                */
/* -------------------------------------------------------------------------- */
/**
 * 404 兜底。
 *
 * ⚠️ **不得**再对后台组返回整数 `40401`——那违反 `docs/README.md:34`
 * （「Agent 组用整数码；shop/admin/merchant 用字符串码」）。
 */
app.notFound((c) => {
  const path = c.req.path;
  if (isAgentPath(path)) {
    // Agent 组：整数码（07 §7.1，PiEcho 契约）
    return c.json(
      { code: AGENT_ERROR_CODES.ORDER_NOT_FOUND, message: "资源不存在", data: null },
      404,
    );
  }
  // 后台组：字符串码，按域取（`ERR_ADMIN_NOT_FOUND` / `ERR_SHOP_NOT_FOUND` / …）
  const codes = backofficeErrorCodesForPath(path);
  return backofficeErrorResponse(codes.NOT_FOUND, "资源不存在");
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
  const path = c.req.path;
  if (isAgentPath(path)) {
    return c.json(
      { code: AGENT_ERROR_CODES.INTERNAL_ERROR, message: "服务内部错误", data: null },
      500,
    );
  }
  const codes = backofficeErrorCodesForPath(path);
  return backofficeErrorResponse(codes.INTERNAL_ERROR, "服务内部错误");
});

/**
 * 测试用请求入口（与 Hono 的 `app.request` 同签名，但**固定返回 `Promise`**，
 * 便于测试 helper 以 `{ request }` 结构化类型接收）。
 */
async function request(
  input: Request | string | URL,
  requestInit?: RequestInit,
  env?: Env,
  executionCtx?: ExecutionContext,
): Promise<Response> {
  return await app.request(input, requestInit, env, executionCtx);
}

/**
 * Workers 导出对象。
 *
 * - `fetch` 指向 Hono 实例的原生入口（生产入口）
 * - `request` 供测试用（`agent-contract.test.ts` / `admin-auth.test.ts` 的 `app.request(...)`）
 * - `scheduled` 由 Cron 触发（触发器配置见 `wrangler.jsonc` 的 `triggers.crons`）
 * - `queue` —— **升级缝 S1 的消费者出口**。只有 `wrangler.jsonc` 里存在
 *   Queues 绑定时 Cloudflare 才会调用它；默认配置无该绑定，故默认形态下
 *   此函数不会被调用（「删绑定即回滚」在代码层的体现）。实现见
 *   `apps/api/src/jobs/index.ts`，与 Cron 路径**共用同一张分发表**。
 */
export default {
  fetch: app.fetch,
  request,
  scheduled,
  queue,
};
