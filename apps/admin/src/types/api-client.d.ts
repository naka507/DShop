/**
 * `@dshop/api-client` 的**临时模块声明**。
 *
 * `packages/api-client` 由另一位同事**并行创建**（`docs/03` §3 目录结构），
 * 本文件写作时该包尚未落盘。TypeScript 的解析优先级是：
 * **真实模块解析成功 → 使用真实包的类型；解析失败 → 才回退到 `declare module` 环境声明**。
 *
 * 因此本文件：
 * - 现在让 `apps/admin` 的 `tsc --noEmit` 能通过（不阻塞 M0 闸门）
 * - 一旦 `packages/api-client` 落盘，**自动失效、无需删除**（环境声明不再被使用）
 *
 * 运行期形状仍由 `src/api/client.ts` 的 `resolvePackageClient()` 运行时探测决定，
 * 探测不到就降级到同源 `fetch`（相对路径 `/api/v1/*`，带 `credentials: "include"`）。
 */
declare module "@dshop/api-client" {
  /**
   * 创建后台 API 客户端。
   *
   * 约定形状（本适配层在 `src/api/client.ts` 运行时探测）：
   * 返回对象带 `request<T>(path, init?)`，`path` 为**相对路径**（`/admin/...`，不含 `/api/v1` 前缀）。
   */
  export function createApiClient(options?: {
    readonly basePath?: string;
    readonly credentials?: RequestCredentials;
  }): {
    request<T>(
      path: string,
      init?: RequestInit,
    ): Promise<{
      readonly code: string | number;
      readonly message: string;
      readonly data: T;
    }>;
  };

  /** 类型化端点（`hc` 风格）；本适配层暂未使用，仅为形状占位。 */
  export const endpoints: unknown;
}
