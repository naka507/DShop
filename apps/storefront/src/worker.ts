/**
 * DShop C 端商城前台的 Worker 入口 —— **薄 Worker**，不含任何业务逻辑。
 *
 * 只做两件事：
 * 1. `/api/*` → 经 **Service Binding `API`** 同源反代到 `dshop-api`；
 * 2. 其余路径 → 交给 **Workers Assets**（`env.ASSETS`）处理静态资源，
 *    SPA 回退由 `wrangler.jsonc` 的 `assets.not_found_handling` 负责。
 *
 * 为什么用 Service Binding 而不是公网 `fetch("https://dshop-api...")`：
 * 免公网往返、免出网计费，且不依赖 API 的对外域名（见
 * `docs/12-eshop架构对齐审计.md` §12.3.4「必须照抄的硬知识」）。
 *
 * 前端 `src/api/transport.ts` 强制使用相对路径 `/api/v1/*`，正是为此设计：
 * 开发期由 Vite 代理转发，生产期由本 Worker 同源反代，前端代码无需感知环境。
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

    // `/api` 与 `/api/*` 都归 API；原样透传请求（含方法、头、体），
    // 故 `dshop-api` 收到的路径仍是 `/api/v1/...`，与其路由挂载一致。
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return env.API.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
