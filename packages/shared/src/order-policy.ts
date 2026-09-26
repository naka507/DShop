/**
 * 订单策略常量（契约中心，零业务逻辑）。
 *
 * 权威依据：`docs/08-核心业务流程.md` §8.6「超时未支付关单」——
 * 支付期限是**下单侧与关单侧共用的判据**，因此它必须落在**两侧都依赖的
 * 契约层**（`@dshop/shared`），而不是某一个调用方的源码里。
 *
 * ## 为什么放在这里（依赖方向纪律）
 *
 * 该常量原先定义在 `apps/api/src/routes/shop/orders.ts`（HTTP 路由层）。
 * 消费端 `apps/api/src/jobs/task-queue.ts`（作业层）要用它做
 * 「`pay_deadline` 缺失/非法时的兜底期限」，于是形成
 * **作业层 → 路由层** 的**反向**跨层依赖——路由是外层，作业不应依赖它。
 *
 * 移到 `@dshop/shared` 后，两侧都只依赖契约中心，依赖方向单向且不产生环。
 */
export const ORDER_PAY_TIMEOUT_MINUTES = 15;
