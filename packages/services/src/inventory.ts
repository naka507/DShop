/**
 * 库存计算（`docs/05` §5.3①）。
 *
 * **可售 = `stock - locked_stock`**。
 *
 * 库存操作铁律：
 * - 下单 → 只**锁定**（`locked_stock += n`），不动 `stock`
 * - 支付成功 → **实扣**（`stock -= n`，同时 `locked_stock -= n`）
 * - 取消 → 只**释放**（`locked_stock -= n`）
 * - **禁止**下单时同时减 `stock` 与加 `locked_stock`（会造成双重扣减）
 */

/** 可售库存。负数（脏数据）按 0 处理，绝不返回负可售。 */
export function availableStock(row: { stock: number; lockedStock: number }): number {
  return Math.max(row.stock - row.lockedStock, 0);
}

/** 是否可售（`available >= quantity`）。 */
export function canSell(row: { stock: number; lockedStock: number }, quantity: number): boolean {
  if (quantity <= 0) return false;
  return availableStock(row) >= quantity;
}

/** 是否缺货（可售为 0）。 */
export function isOutOfStock(row: { stock: number; lockedStock: number }): boolean {
  return availableStock(row) === 0;
}

/**
 * 库存状态文案（`docs/07` §7.4 `stock` 端点的 `stockStatus`）。
 *
 * ⚠️ 文档未定义该字段的取值集合；实现侧按以下三值定案并登记：
 * - `in_stock`    可售 > 阈值
 * - `low_stock`   0 < 可售 ≤ 阈值
 * - `out_of_stock` 可售 = 0
 */
export const STOCK_STATUS = {
  IN_STOCK: "in_stock",
  LOW_STOCK: "low_stock",
  OUT_OF_STOCK: "out_of_stock",
} as const;
export type StockStatus = (typeof STOCK_STATUS)[keyof typeof STOCK_STATUS];

/** 低库存阈值（可售 ≤ 该值视为 `low_stock`）。 */
export const LOW_STOCK_THRESHOLD = 5;

export function stockStatus(row: { stock: number; lockedStock: number }): StockStatus {
  const available = availableStock(row);
  if (available === 0) return STOCK_STATUS.OUT_OF_STOCK;
  if (available <= LOW_STOCK_THRESHOLD) return STOCK_STATUS.LOW_STOCK;
  return STOCK_STATUS.IN_STOCK;
}

/**
 * 下单锁定：返回新的 `{ stock, lockedStock }`。
 *
 * 只增 `lockedStock`，`stock` 保持不变。库存不足时返回 `null`。
 */
export function lockForOrder(
  row: { stock: number; lockedStock: number },
  quantity: number,
): { stock: number; lockedStock: number } | null {
  if (!canSell(row, quantity)) return null;
  return { stock: row.stock, lockedStock: row.lockedStock + quantity };
}

/**
 * 支付成功实扣：`stock -= n` 且 `lockedStock -= n`。
 *
 * `lockedStock` 不会扣成负数。
 */
export function commitPayment(
  row: { stock: number; lockedStock: number },
  quantity: number,
): { stock: number; lockedStock: number } {
  return {
    stock: Math.max(row.stock - quantity, 0),
    lockedStock: Math.max(row.lockedStock - quantity, 0),
  };
}

/**
 * 取消释放：只减 `lockedStock`，`stock` 不变。
 *
 * `lockedStock` 不会释放成负数。
 */
export function releaseLock(
  row: { stock: number; lockedStock: number },
  quantity: number,
): { stock: number; lockedStock: number } {
  return {
    stock: row.stock,
    lockedStock: Math.max(row.lockedStock - quantity, 0),
  };
}
