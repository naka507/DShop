/**
 * 门店 / 仓库列表页（**只读**）。
 *
 * 权威来源：`docs/05` §5.2（`stores`：`type`(warehouse/store)、`supports_pickup`）、
 * `docs/07` §7.5（`shipFrom` 的 `StockShipFromSchema`：storeId/type/city/province/supportsPickup）。
 */

import { Alert, Card, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ReactNode } from "react";

import { listStores } from "../api/services.js";
import type { StoreSummary } from "../api/types.js";
import { useAsyncData } from "../hooks/useAsyncData.js";

const { Text, Paragraph, Title } = Typography;

/** 页面属性。 */
export interface StoresPageProps {
  readonly isPlatform: boolean;
}

/** 门店 / 仓库列表页（只读）。 */
export function StoresPage(props: StoresPageProps): ReactNode {
  const { isPlatform } = props;
  const state = useAsyncData((signal) => listStores(isPlatform, signal), [isPlatform]);

  const columns: ColumnsType<StoreSummary> = [
    {
      title: "门店 ID",
      dataIndex: "id",
      key: "id",
      width: 220,
      render: (value: string) => <Text code>{value}</Text>,
    },
    { title: "名称", dataIndex: "name", key: "name" },
    {
      title: "类型",
      dataIndex: "type",
      key: "type",
      width: 110,
      render: (value: string) => (
        <Tag color={value === "warehouse" ? "blue" : "green"}>
          {value === "warehouse" ? "仓（warehouse）" : "门店（store）"}
        </Tag>
      ),
    },
    { title: "省", dataIndex: "province", key: "province", width: 110 },
    { title: "市", dataIndex: "city", key: "city", width: 110 },
    {
      title: "支持自提",
      dataIndex: "supportsPickup",
      key: "supportsPickup",
      width: 110,
      render: (value: boolean) => (value ? <Tag color="green">是</Tag> : <Tag>否</Tag>),
    },
    {
      title: "所属商户",
      dataIndex: "merchantId",
      key: "merchantId",
      width: 220,
      render: (value: string) => <Text code>{value}</Text>,
    },
    { title: "状态", dataIndex: "status", key: "status", width: 100 },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginBottom: 0 }}>
          门店与仓库（只读）
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          门店是 Agent <Text code>shipFrom</Text> 的来源（docs/07 §7.2 / §7.5）。
        </Paragraph>
      </Card>

      <Card title="门店列表">
        {state.error !== null ? (
          <Alert type="error" showIcon message={state.error} style={{ marginBottom: 12 }} />
        ) : null}
        <Table<StoreSummary>
          rowKey="id"
          size="small"
          loading={state.loading}
          dataSource={state.data?.list ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "暂无门店" }}
        />
      </Card>
    </Space>
  );
}
