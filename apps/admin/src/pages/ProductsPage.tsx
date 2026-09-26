/**
 * 商品列表页（**只读**）。
 *
 * 权威来源：`docs/03` §3.5.2（后台页面清单）、`docs/05` §5.2（`products` 字段）。
 * M0 只做只读展示——商品写路径属商户后台后续里程碑（`docs/10` 里程碑）。
 *
 * ⚠️ 后台视图**不展示** `cost_price` / 供应商 / 采购价 / 内部备注
 * （`docs/M0-实施简报` §4.4 绝不下发清单）。
 */

import { Alert, Card, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ReactNode } from "react";

import { listProducts } from "../api/services.js";
import type { ProductSummary } from "../api/types.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { formatDateTime, formatMoney } from "../utils/format.js";

const { Text, Paragraph, Title } = Typography;

/** 商品状态 → Tag 颜色（`PRODUCT_STATUS`）。 */
const PRODUCT_STATUS_COLOR: Record<string, string> = {
  draft: "default",
  pending_review: "orange",
  onsale: "green",
  offsale: "red",
  rejected: "red",
};

/** 页面属性。 */
export interface ProductsPageProps {
  readonly isPlatform: boolean;
}

/** 商品列表页（只读）。 */
export function ProductsPage(props: ProductsPageProps): ReactNode {
  const { isPlatform } = props;
  const state = useAsyncData(
    (signal) => listProducts(isPlatform, { page: 1, pageSize: 20 }, signal),
    [isPlatform],
  );

  const columns: ColumnsType<ProductSummary> = [
    {
      title: "SPU",
      dataIndex: "spuId",
      key: "spuId",
      width: 220,
      render: (value: string) => <Text code>{value}</Text>,
    },
    { title: "标题", dataIndex: "title", key: "title" },
    { title: "副标题", dataIndex: "subtitle", key: "subtitle" },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (value: string) => (
        <Tag color={PRODUCT_STATUS_COLOR[value] ?? "default"}>{value}</Tag>
      ),
    },
    {
      title: "价格区间",
      key: "price",
      width: 180,
      render: (_: unknown, row: ProductSummary) =>
        row.minPrice === row.maxPrice
          ? formatMoney(row.minPrice)
          : `${formatMoney(row.minPrice)} ~ ${formatMoney(row.maxPrice)}`,
    },
    {
      title: "商户",
      dataIndex: "merchantId",
      key: "merchantId",
      width: 220,
      render: (value: string) => <Text code>{value}</Text>,
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 180,
      render: (value: string) => formatDateTime(value),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginBottom: 0 }}>
          商品（只读）
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          商品规格与库存的**对外契约**由 Agent 端点{" "}
          <Text code>/products/&#123;spuId&#125;/specs</Text> 与 <Text code>/stock</Text>{" "}
          定义，后台与 Agent **同源同 Schema**（docs/03 §3.5.1）。
        </Paragraph>
      </Card>

      <Card title="商品列表">
        {state.error !== null ? (
          <Alert type="error" showIcon message={state.error} style={{ marginBottom: 12 }} />
        ) : null}
        <Table<ProductSummary>
          rowKey="spuId"
          size="small"
          loading={state.loading}
          dataSource={state.data?.list ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "暂无商品" }}
        />
      </Card>
    </Space>
  );
}
