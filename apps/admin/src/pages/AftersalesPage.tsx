/**
 * 售后单列表页。
 *
 * 权威来源：`docs/08` §8.4（售后状态机）、`docs/07` §7.5。
 * 状态取值与文案来自 `packages/shared/src/enums.ts` 的 `AFTERSALE_STATUS` /
 * `AFTERSALE_STATUS_TEXT`（此处只做展示映射，不重定义枚举）。
 */

import { Alert, Card, Input, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { listAftersales } from "../api/services.js";
import type { AftersaleSummary } from "../api/types.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { formatDateTime, formatMoney } from "../utils/format.js";

const { Text, Paragraph, Title } = Typography;

/** 售后状态 → Tag 颜色（未终结状态用暖色，终结状态用冷/绿色）。 */
const AFTERSALE_STATUS_COLOR: Record<string, string> = {
  PENDING_MERCHANT: "orange",
  WAIT_BUYER_RETURN: "gold",
  BUYER_RETURNED: "blue",
  MERCHANT_RECEIVED: "cyan",
  REFUNDING: "purple",
  REFUNDED: "green",
  REJECTED: "red",
  CANCELLED: "default",
};

/** 页面属性。 */
export interface AftersalesPageProps {
  readonly isPlatform: boolean;
}

/** 售后单列表页。 */
export function AftersalesPage(props: AftersalesPageProps): ReactNode {
  const { isPlatform } = props;
  const [status, setStatus] = useState("");
  const [appliedStatus, setAppliedStatus] = useState("");

  const state = useAsyncData(
    (signal) =>
      listAftersales(
        isPlatform,
        { page: 1, pageSize: 20, ...(appliedStatus.length === 0 ? {} : { status: appliedStatus }) },
        signal,
      ),
    [isPlatform, appliedStatus],
  );

  const columns: ColumnsType<AftersaleSummary> = [
    {
      title: "售后单号",
      dataIndex: "aftersaleNo",
      key: "aftersaleNo",
      width: 170,
      render: (value: string) => (
        <Link to={`aftersales/${value}`}>
          <Text code>{value}</Text>
        </Link>
      ),
    },
    { title: "类型", dataIndex: "typeText", key: "typeText", width: 100 },
    {
      title: "状态",
      dataIndex: "statusText",
      key: "status",
      width: 120,
      render: (value: string, row: AftersaleSummary) => (
        <Tag color={AFTERSALE_STATUS_COLOR[row.status] ?? "default"}>{value}</Tag>
      ),
    },
    {
      title: "关联订单",
      dataIndex: "orderNo",
      key: "orderNo",
      width: 220,
      render: (value: string) => <Text code>{value}</Text>,
    },
    { title: "商品", dataIndex: "itemTitle", key: "itemTitle" },
    { title: "数量", dataIndex: "quantity", key: "quantity", width: 70 },
    {
      title: "退款金额",
      dataIndex: "refundAmount",
      key: "refundAmount",
      width: 120,
      render: (value: number, row: AftersaleSummary) => formatMoney(value, row.currency),
    },
    {
      title: "申请时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: "处理截止",
      dataIndex: "deadlineAt",
      key: "deadlineAt",
      width: 180,
      render: (value: string | null) => formatDateTime(value),
    },
    {
      title: "操作",
      key: "actions",
      width: 90,
      render: (_: unknown, row: AftersaleSummary) => (
        <Link to={`aftersales/${row.aftersaleNo}`}>详情</Link>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginBottom: 0 }}>
          售后单
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          状态机见 docs/08 §8.4；每次流转都必须写 <Text code>aftersale_logs</Text>，
          时间线的唯一来源。
        </Paragraph>
      </Card>

      <Card title="售后单列表">
        <Space style={{ marginBottom: 12 }}>
          <Input
            allowClear
            placeholder="按状态过滤（如 PENDING_MERCHANT）"
            style={{ width: 300 }}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
            }}
            onPressEnter={() => {
              setAppliedStatus(status.trim());
            }}
          />
        </Space>

        {state.error !== null ? (
          <Alert type="error" showIcon message={state.error} style={{ marginBottom: 12 }} />
        ) : null}

        <Table<AftersaleSummary>
          rowKey="aftersaleNo"
          size="small"
          loading={state.loading}
          dataSource={state.data?.list ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "暂无售后单" }}
        />
      </Card>
    </Space>
  );
}
