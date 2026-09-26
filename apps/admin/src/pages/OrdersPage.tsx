/**
 * 订单列表页。
 *
 * ★ `docs/08` §8.3 / `docs/M0-实施简报` §4.2：**主单与子单状态必须同时下发**。
 * 列表页直接展示「主单状态 + 子单状态摘要」，详情页展示全部子单。
 * 主单状态**恒由子单聚合**（先剔除 `CANCELLED` 子单），不单独维护。
 */

import { Alert, Button, Card, Input, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { listOrders } from "../api/services.js";
import type { OrderSummary } from "../api/types.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { formatDateTime, formatMoney } from "../utils/format.js";

const { Text, Paragraph, Title } = Typography;

/** 主单状态 → Tag 颜色。 */
const ORDER_STATUS_COLOR: Record<string, string> = {
  PENDING_PAYMENT: "default",
  PAID: "blue",
  SHIPPED: "cyan",
  COMPLETED: "green",
  CANCELLED: "red",
};

/** 页面属性。 */
export interface OrdersPageProps {
  readonly isPlatform: boolean;
}

/** 订单列表页。 */
export function OrdersPage(props: OrdersPageProps): ReactNode {
  const { isPlatform } = props;
  const [orderNo, setOrderNo] = useState("");
  const [appliedOrderNo, setAppliedOrderNo] = useState("");

  const state = useAsyncData(
    (signal) =>
      listOrders(
        isPlatform,
        {
          page: 1,
          pageSize: 20,
          ...(appliedOrderNo.length === 0 ? {} : { orderNo: appliedOrderNo }),
        },
        signal,
      ),
    [isPlatform, appliedOrderNo],
  );

  const columns: ColumnsType<OrderSummary> = [
    {
      title: "订单号",
      dataIndex: "orderNo",
      key: "orderNo",
      width: 220,
      render: (value: string) => (
        <Link to={`orders/${value}`}>
          <Text code>{value}</Text>
        </Link>
      ),
    },
    {
      title: "主单状态",
      dataIndex: "statusText",
      key: "status",
      width: 110,
      render: (value: string, row: OrderSummary) => (
        <Tag color={ORDER_STATUS_COLOR[row.status] ?? "default"}>{value}</Tag>
      ),
    },
    {
      title: "子单状态",
      key: "subOrderStatuses",
      render: (_: unknown, row: OrderSummary) =>
        row.subOrderStatuses.length === 0 ? (
          <Text type="secondary">—</Text>
        ) : (
          <Space size={4} wrap>
            {row.subOrderStatuses.map((s) => (
              <Tag key={s.subOrderNo}>
                {s.subOrderNo} · {s.statusText}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: "金额",
      dataIndex: "payAmount",
      key: "payAmount",
      width: 120,
      render: (value: number, row: OrderSummary) => formatMoney(value, row.currency),
    },
    { title: "渠道", dataIndex: "channel", key: "channel", width: 100 },
    {
      title: "下单时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: "操作",
      key: "actions",
      width: 100,
      render: (_: unknown, row: OrderSummary) => <Link to={`orders/${row.orderNo}`}>详情</Link>,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginBottom: 0 }}>
          订单管理
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          主单状态恒由子单聚合（先剔除 <Text code>CANCELLED</Text> 子单，docs/08 §8.3）。
          列表与详情均**同时展示主单与子单状态**。
        </Paragraph>
      </Card>

      <Card title="订单列表">
        <Space style={{ marginBottom: 12 }}>
          <Input
            allowClear
            placeholder="按订单号查询（^DS\d{17}$）"
            style={{ width: 300 }}
            value={orderNo}
            onChange={(e) => {
              setOrderNo(e.target.value);
            }}
            onPressEnter={() => {
              setAppliedOrderNo(orderNo.trim());
            }}
          />
          <Button
            type="primary"
            onClick={() => {
              setAppliedOrderNo(orderNo.trim());
            }}
          >
            查询
          </Button>
          <Button
            onClick={() => {
              setOrderNo("");
              setAppliedOrderNo("");
            }}
          >
            重置
          </Button>
        </Space>

        {state.error !== null ? (
          <Alert type="error" showIcon message={state.error} style={{ marginBottom: 12 }} />
        ) : null}

        <Table<OrderSummary>
          rowKey="orderNo"
          size="small"
          loading={state.loading}
          dataSource={state.data?.list ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "暂无订单" }}
        />
      </Card>
    </Space>
  );
}
