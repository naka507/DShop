/**
 * `@dshop/services` —— 业务服务层。
 *
 * 纯函数为主（便于在 Worker 与测试中直接调用），不直接访问 D1；
 * 数据读取由 `apps/api` 的路由层负责，本层只做**规则计算与脱敏**。
 */

export * from "./mask.js";
export * from "./mask-payload.js";
export * from "./order-status.js";
export * from "./inventory.js";
export * from "./rate-limit.js";
export * from "./contract-version.js";
// —— 升级缝适配器（`docs/04` §4.3 / `docs/12` §12.9.4）：绑定存在性驱动实现选择 ——
export * from "./task-queue.js";
export * from "./product-search.js";
export * from "./read-db.js";
export * from "./cache-port.js";
export * from "./media.js";
