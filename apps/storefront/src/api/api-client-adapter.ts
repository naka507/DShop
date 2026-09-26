/**
 * `@dshop/api-client` 集成缝（**全项目唯一 import 该包的文件**）。
 *
 * ## 为什么这样写
 *
 * `@dshop/api-client` 由并行同事创建（`docs/03-工程结构与前端.md` §3 表格：
 * 「对 Hono app 的类型化客户端封装（hc + Cookie/Bearer 双模式）」），
 * 本任务不掌握其最终导出名。为不把「对方命名」硬编码进 20 个页面，
 * 这里把集成点收敛成**一个文件**：
 *
 * 1. 用 `import * as apiClientModule` 引入整个命名空间（不逐个具名导入，
 *    因此对方增删导出不会让本项目 typecheck 失败）；
 * 2. 通过 `as unknown as Partial<ExpectedApiClient>` 做一次**显式、可审查**的
 *    边界断言（不是 `any`，且只在运行时探测确实存在的工厂函数）；
 * 3. 探测失败 → 回落到本地 `transport.ts`（同样走相对路径 + 统一响应体）。
 *
 * **升级动作**：若对方最终导出名不同，只改本文件的 `ExpectedApiClient`
 * 与 `resolveFetcher` 两处，业务代码零改动。
 *
 * ## 双模鉴权（`docs/09-认证权限与部署.md` §9.1）
 *
 * Web 端是 **HttpOnly Cookie**（`aud=shop`），浏览器自动携带，
 * 因此前端**不接触也不存储任何 token**；小程序/APP 的 `Authorization: Bearer`
 * 属于二期（`docs/03` §3.5.4），由 api-client 承担。
 */

import * as apiClientModule from "@dshop/api-client";

import type { Fetcher, Requester } from "./transport.ts";
import { createRequester } from "./transport.ts";

/** 期望从 `@dshop/api-client` 拿到的能力（可选，探测不到就回落本地实现）。 */
interface ExpectedApiClient {
  /** 期望的工厂名之一：返回一个与 `fetch` 同构的函数。 */
  readonly createFetcher?: (options?: Readonly<Record<string, unknown>>) => Fetcher;
  /** 或：返回一个 `(path, options) => Promise<T>` 的请求器。 */
  readonly createRequester?: (options?: Readonly<Record<string, unknown>>) => Fetcher;
  /** 或：直接导出的 fetch 兼容函数。 */
  readonly fetch?: Fetcher;
}

/** 探测到的 api-client 能力（`undefined` 表示该能力不存在）。 */
const probe = apiClientModule as unknown as Partial<ExpectedApiClient>;

/** 从 api-client 解析出一个 `Fetcher`；解析不到返回 `null`。 */
export function resolveApiClientFetcher(): Fetcher | null {
  // 逐个候选探测（显式列出而非数组遍历：三个候选签名不同，
  // 合并成联合类型会让「无参调用」产生类型错误）。
  const candidates: readonly (() => unknown)[] = [
    () => probe.createFetcher?.(),
    () => probe.createRequester?.(),
  ];
  for (const call of candidates) {
    try {
      const resolved: unknown = call();
      if (typeof resolved === "function") return resolved as Fetcher;
    } catch {
      // 工厂需要参数时忽略，继续尝试下一个候选。
      continue;
    }
  }
  // 最后尝试「直接导出的 fetch 兼容函数」：它本身就是 Fetcher，无需调用。
  if (typeof probe.fetch === "function") return probe.fetch;
  return null;
}

/**
 * 解析实际使用的请求器。
 *
 * 优先用 `@dshop/api-client`（同一份鉴权/重试/错误映射逻辑，多端复用）；
 * 解析不到则回落本地 `transport.ts`——**两者都只走相对路径**，
 * 因此对业务代码完全等价。
 */
export function resolveRequester(): Requester {
  const fetcher = resolveApiClientFetcher();
  return createRequester(fetcher ?? ((input, init) => fetch(input, init)));
}
