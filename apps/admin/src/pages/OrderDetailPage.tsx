/**
 * 订单详情页。
 *
 * ★ `docs/08` §8.3 / `docs/M0-实施简报` §4.2：**主单状态 + 子单状态都要展示**。
 * 主单状态由子单聚合；子单状态独立流转（`PAID`/`SHIPPED`/`COMPLETED`/`CANCELLED`）。
 * 物流轨迹取 `order_status_logs`（`express.traces`，最多最近 10 条）。
 *
 * ⚠️ 收货人信息**已脱敏**（`docs/07` §7.8.2）：手机号保留前 3 后 4、姓名姓氏 + `**`、
 * 地址仅省市区 + `***`。界面不得尝试还原原文。
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
import type { ReactElement, ReactNode } from "react";
import { Link, useParams } from "react-router";

import { getOrderDetail } from "../api/services.js";
import type { OrderDetail, OrderItem, SubOrder } from "../api/types.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { formatDateTime, formatMoney, isValidOrderNo } from "../utils/format.js";

const { Text, Paragraph, Title } = Typography;

/** 子单状态 → Tag 颜色（子单 PAID 的文案是「待发货」，见 `SUB_ORDER_STATUS_TEXT`）。 */
const SUB_ORDER_STATUS_COLOR: Record<string, string> = {
  PAID: "blue",
  SHIPPED: "cyan",
  COMPLETED: "green",
  CANCELLED: "red",
};

/** 商品明细列。 */
const ITEM_COLUMNS: ColumnsType<OrderItem> = [
  {
    title: "SKU",
    dataIndex: "skuId",
    key: "skuId",
    width: 200,
    render: (v: string) => <Text code>{v}</Text>,
  },
  { title: "商品", dataIndex: "title", key: "title" },
  {
    title: "规格",
    dataIndex: "spec",
    key: "spec",
    render: (spec: Readonly<Record<string, string>>) => (
      <Space size={4} wrap>
        {Object.entries(spec).map(([k, v]) => (
          <Tag key={k}>
            {k}: {v}
          </Tag>
        ))}
      </Space>
    ),
  },
  {
    title: "单价",
    dataIndex: "unitPrice",
    key: "unitPrice",
    width: 110,
    render: (v: number) => formatMoney(v),
  },
  { title: "数量", dataIndex: "quantity", key: "quantity", width: 80 },
  {
    title: "小计",
    dataIndex: "subtotal",
    key: "subtotal",
    width: 110,
    render: (v: number) => formatMoney(v),
  },
];

/** 单个子单卡片（状态 + 商品 + 物流）。 */
function SubOrderCard(props: { readonly subOrder: SubOrder }): ReactElement {
  const { subOrder } = props;
  return (
    <Card
      size="small"
      title={
        <Space>
          <Text code>{subOrder.subOrderNo}</Text>
          <Tag color={SUB_ORDER_STATUS_COLOR[subOrder.status] ?? "default"}>
            {subOrder.statusText}
          </Tag>
          <Text type="secondary">{subOrder.merchantName}</Text>
        </Space>
      }
      style={{ marginBottom: 12 }}
    >
      <Descriptions column={2} size="small" style={{ marginBottom: 8 }}>
        <Descriptions.Item label="发货地">
          {subOrder.shipFrom === null
            ? "—"
            : `${subOrder.shipFrom.storeName}（${subOrder.shipFrom.city}）`}
        </Descriptions.Item>
        <Descriptions.Item label="运单号">
          {subOrder.express === null ? "—" : <Text code>{subOrder.express.no}</Text>}
        </Descriptions.Item>
        <Descriptions.Item label="承运商">
          {subOrder.express === null ? "—" : subOrder.express.company}
        </Descriptions.Item>
        <Descriptions.Item label="物流最新状态">
          {subOrder.express === null ? "—" : subOrder.express.latestStatus}
        </Descriptions.Item>
      </Descriptions>

      <Table<OrderItem>
        rowKey="skuId"
        size="small"
        pagination={false}
        dataSource={[...subOrder.items]}
        columns={ITEM_COLUMNS}
      />

      {subOrder.express !== null && subOrder.express.traces.length > 0 ? (
        <Timeline
          style={{ marginTop: 16 }}
          items={subOrder.express.traces.map((t) => ({
            children: (
              <span>
                <Text type="secondary">{formatDateTime(t.time)}</Text> {t.desc}
              </span>
            ),
          }))}
        />
      ) : null}
    </Card>
  );
}

/** 页面属性。 */
export interface OrderDetailPageProps {
  readonly isPlatform: boolean;
}

/** 订单详情页。 */
export function OrderDetailPage(props: OrderDetailPageProps): ReactNode {
  const { isPlatform } = props;
  const params = useParams();
  const orderNo = params["orderNo"] ?? "";

  const valid = isValidOrderNo(orderNo);
  const state = useAsyncData(
    (signal) => getOrderDetail(isPlatform, orderNo, signal),
    [isPlatform, orderNo, valid],
  );

  if (!valid) {
    return (
      <Alert
        type="error"
        showIcon
        message="订单号格式非法"
        description={
          <span>
            订单号必须匹配对外契约 <Text code>^DS\d&#123;17&#125;$</Text>
            （packages/shared/src/ids.ts）。
          </span>
        }
      />
    );
  }

  const detail: OrderDetail | null = state.data;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space>
        <Link to="../orders">
          <Button icon={<ArrowLeftOutlined />}>返回订单列表</Button>
        </Link>
      </Space>

      {state.error !== null ? <Alert type="error" showIcon message={state.error} /> : null}

      {state.loading && detail === null ? (
        <Spin />
      ) : detail === null ? (
        <Empty description="订单不存在或无权查看" />
      ) : (
        <>
          <Card>
            <Title level={4} style={{ marginBottom: 8 }}>
              订单 <Text code>{detail.orderNo}</Text>
            </Title>
            <Descriptions column={3} size="small" bordered>
              <Descriptions.Item label="主单状态">
                <Tag color={SUB_ORDER_STATUS_COLOR[detail.status] ?? "blue"}>
                  {detail.statusText}
                </Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  （由子单聚合，docs/08 §8.3）
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="渠道">{detail.channel}</Descriptions.Item>
              <Descriptions.Item label="应付金额">
                {formatMoney(detail.payAmount, detail.currency)}
              </Descriptions.Item>
              <Descriptions.Item label="下单时间">
                {formatDateTime(detail.createdAt)}
              </Descriptions.Item>
              <Descriptions.Item label="支付时间">
                {formatDateTime(detail.paidAt)}
              </Descriptions.Item>
              <Descriptions.Item label="子单数">{detail.subOrderCount}</Descriptions.Item>
              <Descriptions.Item label="收件人（已脱敏）" span={3}>
                {detail.receiver.name} / {detail.receiver.phone} / {detail.receiver.region}{" "}
                {detail.receiver.addressMasked}
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                  脱敏规则见 docs/07 §7.8.2
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="售后摘要" span={3}>
                未结售后 <Text strong>{detail.aftersaleSummary.openCount}</Text> 笔；已退款{" "}
                {formatMoney(detail.aftersaleSummary.refundedAmount, detail.currency)}
                {detail.aftersaleSummary.hasAftersale ? (
                  <Tag color="orange" style={{ marginLeft: 8 }}>
                    有售后
                  </Tag>
                ) : null}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="子单（状态独立流转）">
            <Paragraph type="secondary">
              部分退款只置该子单 <Text code>CANCELLED</Text>，**不把主单置 CANCELLED**（docs/08
              §8.3）。
            </Paragraph>
            {detail.subOrders.length === 0 ? (
              <Empty description="无子单" />
            ) : (
              detail.subOrders.map((sub) => <SubOrderCard key={sub.subOrderNo} subOrder={sub} />)
            )}
          </Card>
        </>
      )}
    </Space>
  );
}
