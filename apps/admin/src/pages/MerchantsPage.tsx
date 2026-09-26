/**
 * 商户列表页（**只读**）。
 *
 * 权威来源：`docs/05` §5.2（`merchants` 字段：`type`(self/vendor/branch)、
 * `status`(pending/approved/suspended/rejected)）、`docs/09` §9.2（`merchant:approve` 权限点）。
 *
 * M0 只读；审核动作属 `merchant:approve` 权限点，后续里程碑接入。
 */

import { Alert, Card, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ReactNode } from "react";

import { listMerchants } from "../api/services.js";
import type { MerchantSummary } from "../api/types.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { formatDateTime } from "../utils/format.js";

const { Text, Paragraph, Title } = Typography;

/** 商户状态 → Tag 颜色（`MERCHANT_STATUS`）。 */
const MERCHANT_STATUS_COLOR: Record<string, string> = {
  pending: "orange",
  approved: "green",
  suspended: "red",
  rejected: "red",
};

/** 页面属性。 */
export interface MerchantsPageProps {
  readonly isPlatform: boolean;
}

/** 商户列表页（只读）。 */
export function MerchantsPage(props: MerchantsPageProps): ReactNode {
  const { isPlatform } = props;
  const state = useAsyncData((signal) => listMerchants(isPlatform, signal), [isPlatform]);

  const columns: ColumnsType<MerchantSummary> = [
    {
      title: "商户 ID",
      dataIndex: "id",
      key: "id",
      width: 220,
      render: (value: string) => <Text code>{value}</Text>,
    },
    { title: "名称", dataIndex: "name", key: "name" },
    { title: "类型", dataIndex: "type", key: "type", width: 100 },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (value: string) => (
        <Tag color={MERCHANT_STATUS_COLOR[value] ?? "default"}>{value}</Tag>
      ),
    },
    { title: "联系人", dataIndex: "contactName", key: "contactName", width: 140 },
    { title: "联系电话", dataIndex: "contactPhone", key: "contactPhone", width: 160 },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => formatDateTime(value),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginBottom: 0 }}>
          商户（只读）
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          商户数据行级隔离由后端 <Text code>merchantScope</Text> 中间件强制注入{" "}
          <Text code>merchant_id</Text>，不依赖前端传参（docs/09 §9.2）。
        </Paragraph>
      </Card>

      <Card title="商户列表">
        {state.error !== null ? (
          <Alert type="error" showIcon message={state.error} style={{ marginBottom: 12 }} />
        ) : null}
        <Table<MerchantSummary>
          rowKey="id"
          size="small"
          loading={state.loading}
          dataSource={state.data?.list ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "暂无商户" }}
        />
      </Card>
    </Space>
  );
}
