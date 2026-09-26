/**
 * 售后单详情页。
 *
 * 权威来源：`docs/08` §8.4（状态机与退货地址下发时机）、`docs/07` §7.6。
 *
 * ⚠️ 脱敏（`docs/07` §7.8.2）：
 * - 退货地址仅在 `WAIT_BUYER_RETURN` 起有值，且**已脱敏**
 * - `evidence_urls` **不下发**，只有 `evidenceCount`（凭证图 URL 属绝不下发清单）
 * - 快递员电话不下发
 */

import { ArrowLeftOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";

import { getAftersaleDetail } from "../api/services.js";
import type { AftersaleDetail, AftersaleTimelineNode } from "../api/types.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { formatDateTime, formatMoney, isValidAftersaleNo } from "../utils/format.js";

const { Text, Paragraph, Title } = Typography;

/** 时间线操作者 → 中文。 */
const ACTOR_TEXT: Record<string, string> = {
  buyer: "买家",
  merchant: "商家",
  platform: "平台客服",
  system: "系统",
};

/** 页面属性。 */
export interface AftersaleDetailPageProps {
  readonly isPlatform: boolean;
}

/** 售后单详情页。 */
export function AftersaleDetailPage(props: AftersaleDetailPageProps): ReactNode {
  const { isPlatform } = props;
  const params = useParams();
  const aftersaleNo = params["aftersaleNo"] ?? "";
  const valid = isValidAftersaleNo(aftersaleNo);

  const state = useAsyncData(
    (signal) => getAftersaleDetail(isPlatform, aftersaleNo, signal),
    [isPlatform, aftersaleNo, valid],
  );

  if (!valid) {
    return (
      <Alert
        type="error"
        showIcon
        message="售后单号格式非法"
        description={
          <span>
            售后单号必须匹配对外契约 <Text code>^AS\d&#123;11&#125;$</Text>
            （packages/shared/src/ids.ts）。
          </span>
        }
      />
    );
  }

  const detail: AftersaleDetail | null = state.data;

  const timelineColumns: ColumnsType<AftersaleTimelineNode> = [
    {
      title: "时间",
      dataIndex: "time",
      key: "time",
      width: 200,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: "状态",
      dataIndex: "statusText",
      key: "statusText",
      width: 140,
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: "操作者",
      dataIndex: "actor",
      key: "actor",
      width: 110,
      render: (value: string) => ACTOR_TEXT[value] ?? value,
    },
    {
      title: "备注",
      dataIndex: "remark",
      key: "remark",
      render: (value: string | null) => value ?? "—",
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space>
        <Link to="../aftersales">
          <Button icon={<ArrowLeftOutlined />}>返回售后单列表</Button>
        </Link>
      </Space>

      {state.error !== null ? <Alert type="error" showIcon message={state.error} /> : null}

      {state.loading && detail === null ? (
        <Spin />
      ) : detail === null ? (
        <Empty description="售后单不存在或无权查看" />
      ) : (
        <>
          <Card>
            <Title level={4} style={{ marginBottom: 8 }}>
              售后单 <Text code>{detail.aftersaleNo}</Text>
            </Title>
            <Descriptions column={3} size="small" bordered>
              <Descriptions.Item label="状态">
                <Tag color="orange">{detail.statusText}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="类型">{detail.typeText}</Descriptions.Item>
              <Descriptions.Item label="退款金额">
                {formatMoney(detail.refundAmount, detail.currency)}
              </Descriptions.Item>
              <Descriptions.Item label="主单号">
                <Text code>{detail.orderNo}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="子单号">
                <Text code>{detail.subOrderNo}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="SKU">
                <Text code>{detail.skuId}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="商品">
                {detail.itemTitle} × {detail.quantity}
              </Descriptions.Item>
              <Descriptions.Item label="申请时间">
                {formatDateTime(detail.createdAt)}
              </Descriptions.Item>
              <Descriptions.Item label="处理截止">
                {formatDateTime(detail.deadlineAt)}
              </Descriptions.Item>
              <Descriptions.Item label="申请原因" span={3}>
                {detail.reason}
              </Descriptions.Item>
              <Descriptions.Item label="凭证" span={3}>
                共 <Text strong>{detail.evidenceCount}</Text> 张
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                  仅下发计数，`evidence_urls` 属绝不下发清单（docs/07 §7.8.2）
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="退货地址（已脱敏）" span={3}>
                {detail.returnAddress === null ? (
                  <Text type="secondary">未下发（WAIT_BUYER_RETURN 起才有值，docs/08 §8.4）</Text>
                ) : (
                  <>
                    {detail.returnAddress.name} / {detail.returnAddress.phone} /{" "}
                    {detail.returnAddress.region} {detail.returnAddress.addressMasked}
                  </>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="买家回寄" span={3}>
                {detail.returnExpress === null ? (
                  <Text type="secondary">—</Text>
                ) : (
                  <>
                    {detail.returnExpress.company} <Text code>{detail.returnExpress.no}</Text>
                  </>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="退款" span={3}>
                {detail.refund === null ? (
                  <Text type="secondary">—</Text>
                ) : (
                  <>
                    状态 <Tag>{detail.refund.status}</Tag>
                    退款单号 {detail.refund.refundNo ?? "—"}；渠道 {detail.refund.channel ?? "—"}；
                    到账 {formatDateTime(detail.refund.arrivedAt)}； 预计{" "}
                    {detail.refund.estimatedArrivalDays ?? "—"} 天
                  </>
                )}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="时间线（aftersale_logs，唯一来源）">
            <Paragraph type="secondary">
              每次流转必须写 <Text code>aftersale_logs</Text>（docs/08 §8.4）。
            </Paragraph>
            {detail.timeline.length === 0 ? (
              <Empty description="无流转记录" />
            ) : (
              <>
                <Timeline
                  items={detail.timeline.map((node) => ({
                    children: (
                      <span>
                        <Text type="secondary">{formatDateTime(node.time)}</Text>{" "}
                        <Tag>{node.statusText}</Tag>
                        <Text type="secondary">{ACTOR_TEXT[node.actor] ?? node.actor}</Text>
                        {node.remark === null ? null : <> · {node.remark}</>}
                      </span>
                    ),
                  }))}
                />
                <Table<AftersaleTimelineNode>
                  rowKey={(row) => `${row.time}-${row.status}`}
                  size="small"
                  pagination={false}
                  dataSource={[...detail.timeline]}
                  columns={timelineColumns}
                />
              </>
            )}
          </Card>
        </>
      )}
    </Space>
  );
}
