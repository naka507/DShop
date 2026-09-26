/**
 * ★ 售后政策管理页（PiEcho 运营入口之二）。
 *
 * 权威来源：
 * - `docs/07` §7.7 / §7.10：政策发布流程——平台后台 `POST /api/v1/admin/aftersale-policies`，
 *   权限点 `aftersale:policy:manage`，落 `audit_logs`，发布后**主动失效 `/policies/*` 边缘缓存**；
 *   **这是 PiEcho 政策语料的唯一维护入口**（政策变更不需要改代码或重新部署，
 *   PiEcho 按 `contentHash` 自动感知）
 * - `docs/05` §5.2：`aftersale_policies` 字段 `category`（五类）/`title`/`content`(markdown)/
 *   `version`/`effective_from`/`effective_to`/`status(draft/effective/archived)`
 * - `docs/09` §9.2：权限点 `aftersale:policy:manage` 属平台运营角色
 *
 * **按钮级 RBAC**：无 `aftersale:policy:manage` 时「新建政策」「编辑」按钮**不渲染**。
 * 测试断言见 `tests/aftersale-policies.test.tsx`。
 */

import { EditOutlined, PlusOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useState } from "react";
import type { ReactNode } from "react";

import { PERMISSIONS } from "@dshop/shared";

import { ApiError } from "../api/client.js";
import type { PlatformEndpointSet } from "../api/endpoints.js";
import { describeErrorCode } from "../api/errors.js";
import { listAftersalePolicies, saveAftersalePolicy } from "../api/services.js";
import type {
  AftersalePolicy,
  AftersalePolicyPayload,
  PolicyCategory,
  PolicyStatus,
} from "../api/types.js";
import { usePermission } from "../auth/session.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { formatDateTime } from "../utils/format.js";

const { Text, Paragraph, Title } = Typography;

/** 政策分类五类（`POLICY_CATEGORY`，`docs/05` §5.2）。 */
export const POLICY_CATEGORY_OPTIONS: readonly { value: PolicyCategory; label: string }[] = [
  { value: "return", label: "退货（return）" },
  { value: "refund", label: "退款（refund）" },
  { value: "exchange", label: "换货（exchange）" },
  { value: "freight", label: "运费（freight）" },
  { value: "warranty", label: "质保（warranty）" },
];

/** 政策状态（`draft` 草稿 / `effective` 已生效可对外 / `archived` 已归档）。 */
export const POLICY_STATUS_OPTIONS: readonly { value: PolicyStatus; label: string }[] = [
  { value: "draft", label: "草稿（draft）" },
  { value: "effective", label: "已生效（effective，可对外）" },
  { value: "archived", label: "已归档（archived）" },
];

/** 状态 → Tag 颜色。 */
const STATUS_COLOR: Record<PolicyStatus, string> = {
  draft: "default",
  effective: "green",
  archived: "orange",
};

/** 表单字段（日期用 dayjs 承载，提交前转 ISO）。 */
interface PolicyFormValues {
  readonly category: PolicyCategory;
  readonly title: string;
  readonly content: string;
  readonly version: string;
  readonly effectiveFrom: dayjs.Dayjs;
  readonly effectiveTo: dayjs.Dayjs | null;
  readonly status: PolicyStatus;
  readonly tags: string[];
}

/** 编辑弹窗。 */
function PolicyEditor(props: {
  readonly endpoints: PlatformEndpointSet;
  /** 传 `null` 为新建。 */
  readonly policy: AftersalePolicy | null;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}): ReactNode {
  const { endpoints, policy, onCancel, onSaved } = props;
  const [form] = Form.useForm<PolicyFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function handleSubmit(values: PolicyFormValues): Promise<void> {
    setSubmitting(true);
    setErrorText(null);
    const payload: AftersalePolicyPayload = {
      ...(policy === null ? {} : { id: policy.id }),
      category: values.category,
      title: values.title,
      content: values.content,
      version: values.version,
      effectiveFrom: values.effectiveFrom.toISOString(),
      effectiveTo: values.effectiveTo === null ? null : values.effectiveTo.toISOString(),
      status: values.status,
      tags: values.tags,
    };
    try {
      await saveAftersalePolicy(endpoints, payload);
      void message.success(
        payload.status === "effective"
          ? "政策已发布并生效，/policies/* 边缘缓存已失效，PiEcho 按 contentHash 自动感知"
          : "政策已保存",
      );
      onSaved();
    } catch (cause: unknown) {
      setErrorText(
        cause instanceof ApiError
          ? describeErrorCode(cause.code, cause.message)
          : "保存失败，请稍后重试",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Form<PolicyFormValues>
      form={form}
      layout="vertical"
      initialValues={{
        category: policy?.category ?? "return",
        title: policy?.title ?? "",
        content: policy?.content ?? "",
        version: policy?.version ?? "1.0.0",
        effectiveFrom: policy === null ? dayjs() : dayjs(policy.effectiveFrom),
        effectiveTo:
          policy === null || policy.effectiveTo === null ? null : dayjs(policy.effectiveTo),
        status: policy?.status ?? "draft",
        tags: policy === null ? [] : [...policy.tags],
      }}
      onFinish={(values) => {
        void handleSubmit(values);
      }}
    >
      {errorText !== null ? <Alert type="error" showIcon message={errorText} /> : null}

      <Form.Item
        name="category"
        label="政策分类"
        extra="Agent /policies/{category} 的取值；发布后 PiEcho 按 contentHash 感知（docs/07 §7.7）"
        rules={[{ required: true, message: "请选择分类" }]}
      >
        <Select options={[...POLICY_CATEGORY_OPTIONS]} />
      </Form.Item>

      <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
        <Input maxLength={128} placeholder="例：维修与质保规则（非人为损坏）" />
      </Form.Item>

      <Form.Item
        name="content"
        label="正文（markdown）"
        extra="这是 PiEcho 的政策语料正文——变更不需要改代码或重新部署（docs/07 §7.7）"
        rules={[{ required: true, message: "请输入正文" }]}
      >
        <Input.TextArea rows={10} placeholder="markdown 正文" />
      </Form.Item>

      <Form.Item
        name="version"
        label="版本"
        extra="字符串，例如 1.0.0"
        rules={[{ required: true, message: "请输入版本" }]}
      >
        <Input maxLength={32} />
      </Form.Item>

      <Space size="middle" style={{ display: "flex" }}>
        <Form.Item
          name="effectiveFrom"
          label="生效开始"
          rules={[{ required: true, message: "请选择生效开始时间" }]}
          style={{ flex: 1 }}
        >
          <DatePicker showTime style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="effectiveTo" label="生效结束（可空）" style={{ flex: 1 }}>
          <DatePicker showTime allowClear style={{ width: "100%" }} />
        </Form.Item>
      </Space>

      <Form.Item
        name="status"
        label="状态"
        extra="只有 effective 会被 Agent /policies/{category} 返回（docs/07 §7.1 的 40404 判据）"
        rules={[{ required: true, message: "请选择状态" }]}
      >
        <Select options={[...POLICY_STATUS_OPTIONS]} />
      </Form.Item>

      <Form.Item name="tags" label="标签">
        <Select mode="tags" placeholder="用于 PiEcho 检索的标签，可空" />
      </Form.Item>

      <Space>
        <Button type="primary" htmlType="submit" loading={submitting}>
          {policy === null ? "新建并保存" : "保存修改"}
        </Button>
        <Button onClick={onCancel}>取消</Button>
      </Space>
    </Form>
  );
}

/** 页面属性。 */
export interface AftersalePoliciesPageProps {
  readonly endpoints: PlatformEndpointSet;
}

/** ★ 售后政策管理页。 */
export function AftersalePoliciesPage(props: AftersalePoliciesPageProps): ReactNode {
  const { endpoints } = props;
  const { has } = usePermission();
  // ★ 按钮级 RBAC：权限点来自 packages/shared/src/rbac.ts。
  const canManage = has(PERMISSIONS.AFTERSALE_POLICY_MANAGE);

  const [editing, setEditing] = useState<AftersalePolicy | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const state = useAsyncData(
    (signal) => listAftersalePolicies(endpoints, signal),
    [endpoints.AFTERSALE_POLICIES],
  );

  const columns: ColumnsType<AftersalePolicy> = [
    { title: "分类", dataIndex: "category", key: "category", width: 120 },
    { title: "标题", dataIndex: "title", key: "title" },
    { title: "版本", dataIndex: "version", key: "version", width: 100 },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (status: PolicyStatus) => <Tag color={STATUS_COLOR[status]}>{status}</Tag>,
    },
    {
      title: "生效区间",
      key: "effective",
      width: 260,
      render: (_: unknown, policy: AftersalePolicy) => (
        <span>
          {formatDateTime(policy.effectiveFrom)}
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>
            至 {formatDateTime(policy.effectiveTo)}
          </Text>
        </span>
      ),
    },
    {
      title: "标签",
      dataIndex: "tags",
      key: "tags",
      width: 180,
      render: (tags: readonly string[]) => (
        <Space size={4} wrap>
          {tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 180,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: "操作",
      key: "actions",
      width: 110,
      render: (_: unknown, policy: AftersalePolicy) =>
        canManage ? (
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditing(policy);
              setEditorOpen(true);
            }}
          >
            编辑
          </Button>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Title level={4} style={{ marginBottom: 0 }}>
            售后政策管理
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            这是 <Text strong>PiEcho 政策语料的唯一维护入口</Text>：发布后后端主动失效{" "}
            <Text code>/policies/*</Text> 边缘缓存，PiEcho 按 <Text code>contentHash</Text>{" "}
            自动感知，不需要改代码、重新部署或通知 PiEcho 改配置（docs/07 §7.7 / §7.10）。
          </Paragraph>
          {!canManage ? (
            <Alert
              type="info"
              showIcon
              message="当前账号无 aftersale:policy:manage 权限，仅可查看（按钮已隐藏）"
            />
          ) : null}
        </Space>
      </Card>

      <Card
        title="政策列表"
        extra={
          // ★ 无权限时该按钮不渲染（按钮级 RBAC，docs/09 §9.2）。
          canManage ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              新建政策
            </Button>
          ) : null
        }
      >
        {state.error !== null ? (
          <Alert type="error" showIcon message={state.error} style={{ marginBottom: 12 }} />
        ) : null}
        <Table<AftersalePolicy>
          rowKey="id"
          size="small"
          loading={state.loading}
          dataSource={state.data?.list ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "暂无政策条款。" }}
        />
      </Card>

      <Modal
        open={editorOpen}
        title={editing === null ? "新建售后政策" : `编辑售后政策 · ${editing.title}`}
        footer={null}
        width={760}
        destroyOnClose
        onCancel={() => {
          setEditorOpen(false);
        }}
      >
        <PolicyEditor
          endpoints={endpoints}
          policy={editing}
          onCancel={() => {
            setEditorOpen(false);
          }}
          onSaved={() => {
            setEditorOpen(false);
            state.reload();
          }}
        />
      </Modal>
    </Space>
  );
}
