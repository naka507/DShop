/**
 * DShop 运营/商户后台的 Worker 入口 —— **薄 Worker**，不含任何业务逻辑。
 *
 * 只做两件事：
 * 1. `/api/*` → 经 **Service Binding `API`** 同源反代到 `dshop-api`
 *    （后台登录、RBAC、Agent 令牌管理等接口都在 `/api/v1/admin/*`）；
 * 2. 其余路径 → 交给 **Workers Assets**（`env.ASSETS`）处理静态资源，
 *    SPA 回退由 `wrangler.jsonc` 的 `assets.not_found_handling` 负责。
 *
 * 平台后台与商户后台的 hostname 分流在**客户端**完成（`docs/03` §3.5.2），
 * 故本 Worker 不参与分流，两个域名可复用同一份产物与同一个 Worker。
 *
 * 为什么用 Service Binding 而不是公网 `fetch`：见
 * `docs/12-eshop架构对齐审计.md` §12.3.4「必须照抄的硬知识」。
 */
interface Env {
  /** Service Binding → `dshop-api`（见 `wrangler.jsonc` 的 `services`）。 */
  API: Fetcher;
  /** Workers Assets 绑定（见 `wrangler.jsonc` 的 `assets.binding`）。 */
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // `/api` 与 `/api/*` 都归 API；原样透传请求（含方法、头、体）。
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return env.API.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
