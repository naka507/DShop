/**
 * 主单状态聚合（`docs/08` §8.3）。
 *
 * **主单状态不单独维护，由子单聚合得出。** 聚合前先剔除 `CANCELLED` 子单，
 * 再按以下优先级判定：
 *
 * 1. 全部子单为 `CANCELLED` → `CANCELLED`
 * 2. 剩余子单全部 `COMPLETED` → `COMPLETED`
 * 3. 剩余子单全部 ∈ {`SHIPPED`, `COMPLETED`} 且至少一个 `SHIPPED` → `SHIPPED`
 * 4. 其余 → `PAID`
 *
 * 边界：无子单时视为 `PENDING_PAYMENT`（尚未支付/尚未拆单）。
 */

import { ORDER_STATUS, SUB_ORDER_STATUS } from "@dshop/shared";
import type { OrderStatus, SubOrderStatus } from "@dshop/shared";

/**
 * 由子单状态数组聚合出主单状态。
 *
 * @param subStatuses 该主单下全部子单的状态；空数组返回 `PENDING_PAYMENT`。
 */
export function aggregateOrderStatus(subStatuses: readonly SubOrderStatus[]): OrderStatus {
  if (subStatuses.length === 0) return ORDER_STATUS.PENDING_PAYMENT;

  const active = subStatuses.filter((s) => s !== SUB_ORDER_STATUS.CANCELLED);

  // 1. 全部取消
  if (active.length === 0) return ORDER_STATUS.CANCELLED;

  // 2. 剩余全部完成
  if (active.every((s) => s === SUB_ORDER_STATUS.COMPLETED)) {
    return ORDER_STATUS.COMPLETED;
  }

  // 3. 剩余全部为「已发货/已完成」，且至少一个已发货
  const allShippedOrCompleted = active.every(
    (s) => s === SUB_ORDER_STATUS.SHIPPED || s === SUB_ORDER_STATUS.COMPLETED,
  );
  if (allShippedOrCompleted && active.some((s) => s === SUB_ORDER_STATUS.SHIPPED)) {
    return ORDER_STATUS.SHIPPED;
  }

  // 4. 兜底：已支付
  return ORDER_STATUS.PAID;
}

/** 子单是否处于「未终结」状态（用于售后可申请性判断）。 */
export function isSubOrderOpen(status: SubOrderStatus): boolean {
  return status !== SUB_ORDER_STATUS.CANCELLED;
}
