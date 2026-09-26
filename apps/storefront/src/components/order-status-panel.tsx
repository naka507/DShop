/**
 * 订单状态面板 —— **主单状态 + 每个子单状态都渲染**（`docs/08-核心业务流程.md` §8.3）。
 *
 * ## 为什么单独抽一个组件
 *
 * 「主单与子单状态必须同时下发」是文档硬要求，客服判据是「买了三件为什么只发一件」。
 * 把这条规则收敛到一个纯展示组件里，可以：
 * 1. 被订单详情页与支付结果页复用，避免两处各写一遍后有一处漏掉子单；
 * 2. 被 `tests/order-status-render.test.tsx` 直接渲染断言——
 *    **测试锁定的是「两级状态都出现」这个契约**，而不是某个页面的布局。
 *
 * 组件是**纯展示**（无请求、无副作用），因此测试不需要 mock 网络。
 */

import type { ReactNode } from "react";

import type { OrderStatus, SubOrderStatus } from "@dshop/shared";

import { StatusBadge } from "./ui.tsx";

/** 面板输入：只需要状态字段，不依赖完整订单/快照类型。 */
export interface OrderStatusPanelProps {
  readonly orderNo: string;
  /** 主单状态（`ORDER_STATUS`）。 */
  readonly status: OrderStatus;
  /** 主单状态文案（后端下发）。 */
  readonly statusText: string;
  readonly subOrders: readonly {
    readonly subOrderNo: string;
    readonly status: SubOrderStatus;
    readonly statusText: string;
  }[];
  /** 附加信息（如「更新于 3 秒前」）。 */
  readonly footer?: ReactNode;
}

/** 主单状态色调。 */
function mainTone(status: OrderStatus): "neutral" | "info" | "success" | "warn" {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "SHIPPED":
    case "PAID":
      return "info";
    case "PENDING_PAYMENT":
      return "warn";
    default:
      return "neutral";
  }
}

/** 子单状态色调。 */
function subTone(status: SubOrderStatus): "neutral" | "info" | "success" {
  switch (status) {
    case "COMPLETED":
      return "success";
    case "SHIPPED":
      return "info";
    default:
      return "neutral";
  }
}

/** 订单状态面板（主单 + 子单）。 */
export function OrderStatusPanel({
  orderNo,
  status,
  statusText,
  subOrders,
  footer,
}: OrderStatusPanelProps): ReactNode {
  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-gray-500">主单状态</span>
        <StatusBadge text={statusText} tone={mainTone(status)} />
        <span className="text-xs text-gray-400">订单号 {orderNo}</span>
      </div>
      {footer !== undefined && <div className="mt-2 text-xs text-gray-400">{footer}</div>}

      {/* 子单状态区：每个子单一行，绝不折叠掉。 */}
      <section className="mt-3">
        <h2 className="mb-2 text-sm font-medium text-gray-900">
          子单状态（共 {subOrders.length} 个）
        </h2>
        {subOrders.length === 0 ? (
          <p className="text-sm text-gray-400">无子单</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded border border-gray-100">
            {subOrders.map((sub) => (
              <li
                key={sub.subOrderNo}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <span className="text-sm text-gray-700">{sub.subOrderNo}</span>
                <StatusBadge text={sub.statusText} tone={subTone(sub.status)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
