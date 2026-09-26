/**
 * 分类列表页（**只读**）。
 *
 * 权威来源：`docs/05` §5.2（`categories` 树形，`parent_id` 自引用）、`docs/03` §3.5.2。
 */

import { Alert, Card, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ReactNode } from "react";

import { listCategories } from "../api/services.js";
import type { CategoryNode } from "../api/types.js";
import { useAsyncData } from "../hooks/useAsyncData.js";

const { Text, Paragraph, Title } = Typography;

/** 页面属性。 */
export interface CategoriesPageProps {
  readonly isPlatform: boolean;
}

/** 分类列表页（只读）。 */
export function CategoriesPage(props: CategoriesPageProps): ReactNode {
  const { isPlatform } = props;
  const state = useAsyncData((signal) => listCategories(isPlatform, signal), [isPlatform]);

  const columns: ColumnsType<CategoryNode> = [
    {
      title: "分类 ID",
      dataIndex: "id",
      key: "id",
      width: 220,
      render: (value: string) => <Text code>{value}</Text>,
    },
    { title: "名称", dataIndex: "name", key: "name" },
    { title: "层级", dataIndex: "level", key: "level", width: 80 },
    {
      title: "父分类",
      dataIndex: "parentId",
      key: "parentId",
      width: 220,
      render: (value: string | null) =>
        value === null ? <Text type="secondary">根节点</Text> : <Text code>{value}</Text>,
    },
    { title: "排序", dataIndex: "sortOrder", key: "sortOrder", width: 80 },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (value: string) => <Tag>{value}</Tag>,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginBottom: 0 }}>
          分类（只读）
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          分类树是 Agent <Text code>categoryPath</Text> 的来源（docs/07 §7.4）。
        </Paragraph>
      </Card>

      <Card title="分类列表">
        {state.error !== null ? (
          <Alert type="error" showIcon message={state.error} style={{ marginBottom: 12 }} />
        ) : null}
        <Table<CategoryNode>
          rowKey="id"
          size="small"
          loading={state.loading}
          dataSource={state.data?.list ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "暂无分类" }}
        />
      </Card>
    </Space>
  );
}
