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
 *
 * ## ⚠️ 已知缺口：客服路径在生产环境尚未分派
 *
 * 开发期 `vite.config.ts` 的 `supportProxy` 把客服路径（`/api/v1/{chat,sessions,
 * handover,tickets,auth,health}`）转到 **PiEcho 网关**，其余 `/api/*` 转到 `dshop-api`。
 * **本 Worker 目前只做了后者**——所有 `/api/*` 一律交给 `env.API`（`dshop-api`）。
 *
 * 后果：生产环境下客服请求会打到 `dshop-api` 并返回其 404（**不是**静默错误答案，
 * 但也**不是**可用功能）。故 C 端客服窗口目前**仅在本地可用**。
 *
 * 补齐前提（见 `docs/11` §15 Q11 三项集成契约）：PiEcho 需先有公网端点与
 * Service Binding 目标；在此之前**不得**让前端直连 PiEcho 公网（其**无 CORS 配置**）。
 * 定案后此处应加一层与 `supportProxy` 同构的前缀分派。
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
