import { describe, expect, it } from "vitest";

import { aggregateOrderStatus, isSubOrderOpen } from "../src/order-status.js";
import {
  availableStock,
  canSell,
  commitPayment,
  isOutOfStock,
  lockForOrder,
  releaseLock,
  STOCK_STATUS,
  stockStatus,
} from "../src/inventory.js";

describe("aggregateOrderStatus（docs/08 §8.3）", () => {
  it("无子单 → PENDING_PAYMENT", () => {
    expect(aggregateOrderStatus([])).toBe("PENDING_PAYMENT");
  });

  it("全 CANCELLED → CANCELLED", () => {
    expect(aggregateOrderStatus(["CANCELLED"])).toBe("CANCELLED");
    expect(aggregateOrderStatus(["CANCELLED", "CANCELLED"])).toBe("CANCELLED");
  });

  it("剩余全 COMPLETED → COMPLETED（含被取消的）", () => {
    expect(aggregateOrderStatus(["COMPLETED", "COMPLETED"])).toBe("COMPLETED");
    expect(aggregateOrderStatus(["COMPLETED", "CANCELLED"])).toBe("COMPLETED");
  });

  it("剩余全 ∈ {SHIPPED, COMPLETED} 且至少一 SHIPPED → SHIPPED", () => {
    expect(aggregateOrderStatus(["SHIPPED"])).toBe("SHIPPED");
    expect(aggregateOrderStatus(["SHIPPED", "COMPLETED"])).toBe("SHIPPED");
    expect(aggregateOrderStatus(["SHIPPED", "CANCELLED"])).toBe("SHIPPED");
  });

  it("否则 → PAID", () => {
    expect(aggregateOrderStatus(["PAID"])).toBe("PAID");
    expect(aggregateOrderStatus(["PAID", "SHIPPED"])).toBe("PAID");
    expect(aggregateOrderStatus(["PAID", "COMPLETED"])).toBe("PAID");
    expect(aggregateOrderStatus(["PAID", "CANCELLED"])).toBe("PAID");
  });

  it("isSubOrderOpen 只排除 CANCELLED", () => {
    expect(isSubOrderOpen("PAID")).toBe(true);
    expect(isSubOrderOpen("SHIPPED")).toBe(true);
    expect(isSubOrderOpen("COMPLETED")).toBe(true);
    expect(isSubOrderOpen("CANCELLED")).toBe(false);
  });
});

describe("库存（docs/05 §5.3①）", () => {
  it("可售 = stock - locked_stock", () => {
    expect(availableStock({ stock: 10, lockedStock: 3 })).toBe(7);
  });

  it("脏数据不返回负可售", () => {
    expect(availableStock({ stock: 1, lockedStock: 5 })).toBe(0);
  });

  it("canSell 边界", () => {
    expect(canSell({ stock: 10, lockedStock: 3 }, 7)).toBe(true);
    expect(canSell({ stock: 10, lockedStock: 3 }, 8)).toBe(false);
    expect(canSell({ stock: 10, lockedStock: 0 }, 0)).toBe(false);
    expect(canSell({ stock: 10, lockedStock: 0 }, -1)).toBe(false);
  });

  it("下单只锁定，不动 stock", () => {
    const next = lockForOrder({ stock: 10, lockedStock: 2 }, 3);
    expect(next).toEqual({ stock: 10, lockedStock: 5 });
  });

  it("库存不足时锁定失败返回 null", () => {
    expect(lockForOrder({ stock: 10, lockedStock: 8 }, 3)).toBeNull();
  });

  it("支付成功实扣 stock 与 locked_stock", () => {
    expect(commitPayment({ stock: 10, lockedStock: 3 }, 3)).toEqual({
      stock: 7,
      lockedStock: 0,
    });
  });

  it("取消只释放 locked_stock，不动 stock", () => {
    expect(releaseLock({ stock: 10, lockedStock: 3 }, 3)).toEqual({
      stock: 10,
      lockedStock: 0,
    });
  });

  it("释放不会变成负数", () => {
    expect(releaseLock({ stock: 10, lockedStock: 1 }, 5)).toEqual({
      stock: 10,
      lockedStock: 0,
    });
  });

  it("禁止同时减 stock 与加 locked_stock 的等价检查", () => {
    // 下单后 stock 必须不变
    const before = { stock: 10, lockedStock: 0 };
    const after = lockForOrder(before, 4);
    expect(after?.stock).toBe(before.stock);
  });

  it("stockStatus 三值", () => {
    expect(stockStatus({ stock: 100, lockedStock: 0 })).toBe(STOCK_STATUS.IN_STOCK);
    expect(stockStatus({ stock: 10, lockedStock: 6 })).toBe(STOCK_STATUS.LOW_STOCK);
    expect(stockStatus({ stock: 10, lockedStock: 10 })).toBe(STOCK_STATUS.OUT_OF_STOCK);
  });

  it("isOutOfStock", () => {
    expect(isOutOfStock({ stock: 3, lockedStock: 3 })).toBe(true);
    expect(isOutOfStock({ stock: 3, lockedStock: 2 })).toBe(false);
  });
});
