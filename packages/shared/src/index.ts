/**
 * `@dshop/shared` —— 契约中心（零业务逻辑）。
 *
 * 任何跨层数据结构先在这里定义 Schema。依赖方向单向：`shared` 不依赖任何内部包。
 */

export * from "./enums.js";
export * from "./errors.js";
export * from "./ids.js";
export * from "./rbac.js";
export * from "./contracts/common.js";
export * from "./contracts/agent.js";
export * from "./contracts/admin.js";
export * from "./contracts/shop.js";
export * from "./contracts/merchant.js";
export * from "./contracts/callbacks.js";
