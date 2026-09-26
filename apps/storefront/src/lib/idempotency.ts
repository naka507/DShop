/**
 * 受控写幂等键生成（`docs/06-API路由命名空间.md` §6：
 * `POST /api/v1/shop/orders` 与 `POST /api/v1/shop/aftersales` 必须带 `Idempotency-Key`）。
 *
 * ## 关键约束：**同一笔提交的重试必须复用同一个键**
 *
 * 因此幂等键由**发起动作的那一刻**生成并保存在组件的 ref / state 里，
 * **不能**在每次 `submit` 调用里重新生成——否则「网络超时后用户再点一次」
 * 会产生两笔订单（`docs/M0-实施简报.md` §5 的原子批次只保证单次请求内的一致性）。
 */

/** 生成一个幂等键（`crypto.randomUUID` 不可用时退化为时间戳 + 随机数）。 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${String(Date.now())}-${Math.random().toString(36).slice(2, 12)}`;
}
