/**
 * `@dshop/api-client` —— 对 DShop API 的类型化客户端（`docs/03:31`）。
 *
 * ## 为什么手写而不用 `hc`
 *
 * `docs/03:31` 提到 Hono `hc`。`hc` 要求把**服务端 `AppType`** 作为类型参数传入，
 * 而本仓库的 `apps/api` 只导出运行时入口（`apps/api/package.json` 的
 * `exports: { ".": "./src/index.ts" }`，无 `AppType` 导出）；直接依赖
 * `apps/api` 会让 `packages/*` 反向依赖 `apps/*`，破坏 `docs/03:40` 的
 * 「`shared` 是多端契约中心、依赖方向单向」。
 *
 * 故本包采用**契约驱动**的手写实现：请求/响应的类型全部来自
 * `@dshop/shared` 的 Zod Schema（契约即类型），与 `hc` 的推导结果等价，
 * 但不引入对 `apps/api` 的依赖，且能承载三件 `hc` 不做的事：
 *
 * 1. **统一响应体解包** `{ code, message, data }`（`docs/06:18`）；
 * 2. **两套错误码分流**（Agent 整数码 vs 后台字符串码，`docs/README.md:34`）；
 * 3. **`X-Service-Token` 鉴权**（Agent 组**不是** `Authorization: Bearer`，`docs/07` §7.8.1）。
 *
 * ## 用法
 *
 * ```ts
 * const client = createApiClient({
 *   baseUrl: "https://api.dshop.example.com",
 *   serviceToken: process.env.DSHOP_SERVICE_TOKEN,
 * });
 * const result = await client.agent.getOrder("DS20260920143000123");
 * if (!result.ok && result.kind === "agent") {
 *   // result.code 是整数码联合类型（40001 / 40101 / 40401 …）
 * }
 * ```
 */

import { AgentApi } from "./agent.js";
import { AdminApi, MerchantApi, ShopApi } from "./backoffice.js";
import { TypedApiClient } from "./client.js";
import type { ClientConfig } from "./client.js";

export * from "./agent.js";
export * from "./backoffice.js";
export * from "./client.js";
export * from "./envelope.js";

/** 四组客户端集合。 */
export interface ApiClient {
  /** C 端商城（`/api/v1/shop/*`，`docs/06:11`）。 */
  readonly shop: ShopApi;
  /** 商户后台（`/api/v1/merchant/*`，`docs/06:12`）。 */
  readonly merchant: MerchantApi;
  /** 平台后台（`/api/v1/admin/*`，`docs/06:13`）。 */
  readonly admin: AdminApi;
  /** Agent 只读契约六端点（`/api/v1/agent/*`，`docs/07` §7.2–§7.7）。 */
  readonly agent: AgentApi;
}

/**
 * 创建四组类型化客户端。
 *
 * 每组持有**各自**的 `TypedApiClient` 实例：`group` 泛型在构造时固定，
 * 因此「Agent 组用 `X-Service-Token`、其余用 Bearer」这一分流是**编译期**保证，
 * 不可能在调用点写错（`docs/07:329`）。
 */
export function createApiClient(config: ClientConfig): ApiClient {
  return {
    shop: new ShopApi(new TypedApiClient("shop", config)),
    merchant: new MerchantApi(new TypedApiClient("merchant", config)),
    admin: new AdminApi(new TypedApiClient("admin", config)),
    agent: new AgentApi(new TypedApiClient("agent", config)),
  };
}

/**
 * 服务令牌头名（`docs/07` §7.8.1）**再导出**，便于调用方无需额外引 `@dshop/shared`
 * 即可设置 Agent 组鉴权头。
 */
export { SERVICE_TOKEN_HEADER } from "@dshop/shared";
