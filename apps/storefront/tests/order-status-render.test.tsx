/**
 * 订单状态渲染测试 —— **锁定「主单 + 每个子单状态都出现」这条硬要求**。
 *
 * 权威来源：`docs/08-核心业务流程.md` §8.3（客服需答「买了三件为什么只发一件」），
 * 以及 `docs/07-Agent-API契约.md` §7.2 的注释：
 * 「主单与子单状态**必须同时下发**」。
 *
 * 这些用例是**契约级回归**：只要有人把子单状态区删掉或折叠，测试立即变红。
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrderStatusPanel } from "../src/components/order-status-panel.tsx";

/** 构造一个「主单已发货、子单状态各不相同」的场景——正是文档的客服判据。 */
const THREE_SUB_ORDERS = [
  { subOrderNo: "DS20260920143000123-01", status: "SHIPPED", statusText: "已发货" },
  { subOrderNo: "DS20260920143000123-02", status: "PAID", statusText: "待发货" },
  { subOrderNo: "DS20260920143000123-03", status: "PAID", statusText: "待发货" },
] as const;

describe("OrderStatusPanel（主单 + 子单状态）", () => {
  it("主单状态与每个子单状态都渲染出来", () => {
    render(
      <OrderStatusPanel
        orderNo="DS20260920143000123"
        status="SHIPPED"
        statusText="已发货"
        subOrders={THREE_SUB_ORDERS}
      />,
    );

    // 主单状态：**限定在「主单状态」标签所在那一行内**断言。
    // 直接用 screen.getByText("已发货") 会同时命中子单 01 的同名文案而抛
    // 「Found multiple elements」——那是测试作用域 bug，不是组件没渲染主单状态。
    const mainRow = screen.getByText("主单状态").parentElement as HTMLElement;
    expect(within(mainRow).getByText("已发货")).toBeTruthy();
    expect(within(mainRow).getByText("订单号 DS20260920143000123")).toBeTruthy();

    // 子单区：**限定在子单区块内**断言，数量必须与 fixture 一致（不允许折叠/截断）。
    const subSection = screen.getByText("子单状态（共 3 个）").parentElement as HTMLElement;
    // 每个子单号都出现。
    for (const sub of THREE_SUB_ORDERS) {
      expect(within(subSection).getByText(sub.subOrderNo)).toBeTruthy();
    }
    // 子单行数 == fixture 子单数（用 getAllByRole 断言数量，而不是「存在」）。
    expect(within(subSection).getAllByRole("listitem")).toHaveLength(THREE_SUB_ORDERS.length);
    // 子单状态文案数量：01 已发货、02/03 待发货。
    expect(within(subSection).getAllByText("已发货")).toHaveLength(1);
    expect(within(subSection).getAllByText("待发货")).toHaveLength(2);
  });

  it("只有一个子单时也同时展示两级状态", () => {
    render(
      <OrderStatusPanel
        orderNo="DS20260920143000124"
        status="COMPLETED"
        statusText="已完成"
        subOrders={[
          { subOrderNo: "DS20260920143000124-01", status: "COMPLETED", statusText: "已签收" },
        ]}
      />,
    );

    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getByText("已签收")).toBeTruthy();
    expect(screen.getByText("DS20260920143000124-01")).toBeTruthy();
  });

  it("子单状态文案为空串时仍渲染该子单行（不静默丢失）", () => {
    render(
      <OrderStatusPanel
        orderNo="DS20260920143000125"
        status="PAID"
        statusText="已支付"
        subOrders={[{ subOrderNo: "DS20260920143000125-01", status: "PAID", statusText: "" }]}
      />,
    );

    expect(screen.getByText("DS20260920143000125-01")).toBeTruthy();
  });

  it("无子单时给出显式提示，而不是空白", () => {
    render(
      <OrderStatusPanel
        orderNo="DS20260920143000126"
        status="CANCELLED"
        statusText="已取消"
        subOrders={[]}
      />,
    );

    expect(screen.getByText("无子单")).toBeTruthy();
    expect(screen.getByText("已取消")).toBeTruthy();
  });
});
