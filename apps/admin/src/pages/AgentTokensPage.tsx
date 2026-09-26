/**
 * ★ Agent 令牌管理页（PiEcho 运营入口之一）。
 *
 * 权威来源：
 * - `docs/06` §6：`POST /api/v1/admin/agent-tokens`、`POST /api/v1/admin/agent-tokens/:id/revoke`
 * - `docs/07` §7.8.1：令牌格式 `dshop_svc_<24 位 base62>_<6 位校验位>`；
 *   **明文仅创建时返回一次**；存储 `token_hash = HMAC-SHA256(AGENT_TOKEN_PEPPER, token)`，
 *   `token_prefix` 存前 16 位；默认有效期 180 天；`rate_limit_per_min` 默认 600
 * - `docs/09` §9.2 / §10.3 步骤 6：权限点 `agent:token:manage`，**强制 TOTP 二次确认** + 落审计
 * - `docs/M0-实施简报` §4.3：轮换「双令牌并行」，旧令牌设 7 天宽限期；revoke 立即生效
 *
 * ★ 「明文只显示一次」的实现（三处共同保证）：
 * 1. 明文只存在 `issued` 这一个组件 state 里，且**只在 `IssueResultModal` 内部渲染**；
 * 2. `IssueResultModal` 的 `onClose` **先把 `issued` 置为 `null` 再关闭**，因此弹窗
 *    一旦关闭，明文从 React 树与 state 中同时消失，**无法再打开查看**（列表接口不回明文）；
 * 3. 关闭按钮文案与提示明确「关闭后不可再见」，并提供复制按钮让用户当场取走。
 *    测试断言见 `tests/agent-tokens.test.tsx`。
 */

import { CopyOutlined, KeyOutlined, PlusOutlined, StopOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";
import type { ReactNode } from "react";

import { PERMISSIONS } from "@dshop/shared";

import { ApiError } from "../api/client.js";
import type { PlatformEndpointSet } from "../api/endpoints.js";
import { describeErrorCode } from "../api/errors.js";
import { issueAgentToken, listAgentTokens, revokeAgentToken } from "../api/services.js";
import type { AgentToken, IssuedAgentToken } from "../api/types.js";
import { usePermission } from "../auth/session.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import { formatDateTime, formatExpiry } from "../utils/format.js";

const { Text, Paragraph, Title } = Typography;

/** 一期四个读 scope（`docs/M0-实施简报` §4.3）。 */
const AGENT_READ_SCOPES = [
  { value: "agent:order:read", label: "订单读（agent:order:read）" },
  { value: "agent:product:read", label: "商品读（agent:product:read）" },
  { value: "agent:aftersale:read", label: "售后读（agent:aftersale:read）" },
  { value: "agent:policy:read", label: "政策读（agent:policy:read）" },
] as const;

/** 默认有效期 180 天（`docs/M0-实施简报` §4.3）。 */
const DEFAULT_EXPIRES_IN_DAYS = 180;

/** 签发表单字段。 */
interface IssueFormValues {
  readonly name: string;
  readonly scopes: string[];
  readonly expiresInDays: number;
  readonly totpCode: string;
}

/** 签发弹窗的表单。 */
function IssueForm(props: {
  readonly onCancel: () => void;
  readonly onIssued: (issued: IssuedAgentToken) => void;
  readonly endpoints: PlatformEndpointSet;
}): ReactNode {
  const { onCancel, onIssued, endpoints } = props;
  const [form] = Form.useForm<IssueFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function handleSubmit(values: IssueFormValues): Promise<void> {
    setSubmitting(true);
    setErrorText(null);
    try {
      const issued = await issueAgentToken(endpoints, {
        name: values.name,
        scopes: values.scopes,
        expiresInDays: values.expiresInDays,
        totpCode: values.totpCode,
      });
      onIssued(issued);
    } catch (cause: unknown) {
      setErrorText(
        cause instanceof ApiError
          ? describeErrorCode(cause.code, cause.message)
          : "签发失败，请稍后重试",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Form<IssueFormValues>
      form={form}
      layout="vertical"
      initialValues={{
        scopes: AGENT_READ_SCOPES.map((s) => s.value),
        expiresInDays: DEFAULT_EXPIRES_IN_DAYS,
        totpCode: "",
      }}
      onFinish={(values) => {
        void handleSubmit(values);
      }}
    >
      {errorText !== null ? <Alert type="error" showIcon message={errorText} /> : null}

      <Form.Item
        name="name"
        label="令牌名称"
        extra="例如 piecho-prod / piecho-staging，用于人工核对交付对象"
        rules={[{ required: true, message: "请输入令牌名称" }]}
      >
        <Input placeholder="piecho-prod" maxLength={64} />
      </Form.Item>

      <Form.Item
        name="scopes"
        label="Scope"
        extra="一期仅四个读 scope；写 scope 二期启用（docs/07 §7.12）"
        rules={[{ required: true, message: "至少选择一个 scope" }]}
      >
        <Select mode="multiple" options={[...AGENT_READ_SCOPES]} />
      </Form.Item>

      <Form.Item
        name="expiresInDays"
        label="有效期（天）"
        extra={`默认 ${String(DEFAULT_EXPIRES_IN_DAYS)} 天；到期前 30 天 Cron 告警`}
        rules={[{ required: true, message: "请输入有效期" }]}
      >
        <InputNumber min={1} max={730} style={{ width: "100%" }} />
      </Form.Item>

      <Form.Item
        name="totpCode"
        label="动态验证码（TOTP）★ 强制"
        extra="签发 Agent 令牌强制 TOTP 二次确认并落 audit_logs（docs/09 §9.2、docs/M0-实施简报 §4.3）"
        rules={[
          { required: true, message: "请输入 6 位动态验证码" },
          { len: 6, message: "动态验证码为 6 位" },
        ]}
      >
        <Input
          inputMode="numeric"
          maxLength={6}
          placeholder="6 位数字"
          autoComplete="one-time-code"
        />
      </Form.Item>

      <Space>
        <Button type="primary" htmlType="submit" loading={submitting}>
          签发
        </Button>
        <Button onClick={onCancel}>取消</Button>
      </Space>
    </Form>
  );
}

/**
 * ★ 明文令牌结果弹窗。
 *
 * **该弹窗是明文令牌的唯一渲染处**。关闭时由父组件把 `issued` 置 `null`，
 * 明文随之从 React 树与内存 state 中消失，且列表接口不再返回明文——
 * 因此「关闭后不可再见」是结构性的，而非提示性的。
 */
export function IssueResultModal(props: {
  readonly issued: IssuedAgentToken;
  readonly onClose: () => void;
}): ReactNode {
  const { issued, onClose } = props;
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
      void message.success("已复制到剪贴板");
    } catch {
      void message.warning("复制失败，请手动选中后复制");
    }
  }

  return (
    <Modal
      open
      title="令牌已签发 —— 请立即复制"
      // 关闭动作统一走 onClose：父组件在此把明文 state 置 null。
      onCancel={onClose}
      maskClosable={false}
      keyboard={false}
      footer={[
        <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={() => void handleCopy()}>
          {copied ? "已复制，再复制一次" : "复制明文令牌"}
        </Button>,
        <Button key="close" danger onClick={onClose}>
          我已妥善保存，关闭
        </Button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Alert
          type="warning"
          showIcon
          message="明文令牌只显示这一次"
          description={
            <span>
              服务端只存 <Text code>token_hash = HMAC-SHA256(AGENT_TOKEN_PEPPER, token)</Text> 与前
              16 位 <Text code>token_prefix</Text>，<Text strong>无法再次取出</Text>。关闭本弹窗后，
              明文将从界面与内存中消失，只能吊销后重新签发。
            </span>
          }
        />

        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="名称">{issued.name}</Descriptions.Item>
          <Descriptions.Item label="令牌前缀">
            <Text code>{issued.tokenPrefix}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="到期时间">
            {formatDateTime(issued.expiresAt)}（{formatExpiry(issued.expiresAt)}）
          </Descriptions.Item>
          <Descriptions.Item label="Scope">
            {issued.scopes.map((s) => (
              <Tag key={s}>{s}</Tag>
            ))}
          </Descriptions.Item>
        </Descriptions>

        <div>
          <Title level={5} style={{ marginBottom: 4 }}>
            明文令牌
          </Title>
          <Paragraph
            copyable={false}
            style={{
              wordBreak: "break-all",
              background: "#fafafa",
              border: "1px solid #f0f0f0",
              borderRadius: 4,
              padding: 8,
              fontFamily: "monospace",
              marginBottom: 0,
            }}
          >
            {issued.token}
          </Paragraph>
          <Text type="secondary" style={{ fontSize: 12 }}>
            通过安全渠道交付给 PiEcho，写入其 <Text code>ESHOP_SERVICE_TOKEN</Text>
            （传输头 <Text code>X-Service-Token</Text>，非 Bearer，不允许放 query string）。
          </Text>
        </div>
      </Space>
    </Modal>
  );
}

/** 页面属性。 */
export interface AgentTokensPageProps {
  readonly endpoints: PlatformEndpointSet;
}

/** ★ Agent 令牌管理页。 */
export function AgentTokensPage(props: AgentTokensPageProps): ReactNode {
  const { endpoints } = props;
  const { has } = usePermission();
  const canManage = has(PERMISSIONS.AGENT_TOKEN_MANAGE);

  const [issueOpen, setIssueOpen] = useState(false);
  // ★ 明文令牌的唯一持有处；关闭结果弹窗即置 null（见 IssueResultModal 注释）。
  const [issued, setIssued] = useState<IssuedAgentToken | null>(null);

  const state = useAsyncData(
    (signal) => listAgentTokens(endpoints, signal),
    [endpoints.AGENT_TOKENS],
  );

  async function handleRevoke(token: AgentToken): Promise<void> {
    try {
      await revokeAgentToken(endpoints, token.id);
      void message.success(`已吊销「${token.name}」，立即生效`);
      state.reload();
    } catch (cause: unknown) {
      void message.error(
        cause instanceof ApiError
          ? describeErrorCode(cause.code, cause.message)
          : "吊销失败，请稍后重试",
      );
    }
  }

  const columns: ColumnsType<AgentToken> = [
    { title: "名称", dataIndex: "name", key: "name", width: 180 },
    {
      title: "令牌前缀",
      dataIndex: "tokenPrefix",
      key: "tokenPrefix",
      width: 180,
      render: (value: string) => <Text code>{value}</Text>,
    },
    {
      title: "Scope",
      dataIndex: "scopes",
      key: "scopes",
      render: (scopes: readonly string[]) => (
        <Space size={4} wrap>
          {scopes.map((s) => (
            <Tag key={s}>{s}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (status: string) =>
        status === "active" ? <Tag color="green">生效中</Tag> : <Tag color="red">已吊销</Tag>,
    },
    {
      title: "到期",
      dataIndex: "expiresAt",
      key: "expiresAt",
      width: 200,
      render: (value: string) => (
        <span>
          {formatDateTime(value)}
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatExpiry(value)}
          </Text>
        </span>
      ),
    },
    {
      title: "最近使用",
      dataIndex: "lastUsedAt",
      key: "lastUsedAt",
      width: 180,
      render: (value: string | null) => formatDateTime(value),
    },
    {
      title: "操作",
      key: "actions",
      width: 120,
      render: (_: unknown, token: AgentToken) =>
        token.status === "active" && canManage ? (
          <Popconfirm
            title="确认吊销该令牌？"
            description="吊销立即生效，PiEcho 将立刻无法调用 Agent 接口（docs/07 §7.8.1）。"
            okText="确认吊销"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleRevoke(token)}
          >
            <Button danger size="small" icon={<StopOutlined />}>
              吊销
            </Button>
          </Popconfirm>
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
            <KeyOutlined /> Agent 服务令牌
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            PiEcho（AI 客服）以 <Text code>X-Service-Token</Text> 调用{" "}
            <Text code>/api/v1/agent/*</Text>（仅 GET）。令牌是不透明串 + 数据库哈希比对， 因此
            <Text strong>可立即吊销</Text>——这是不用 JWT 的唯一理由（docs/09 §9.1）。
          </Paragraph>
          {!canManage ? (
            <Alert
              type="info"
              showIcon
              message="当前账号无 agent:token:manage 权限，仅可查看（签发与吊销按钮已隐藏）"
            />
          ) : null}
        </Space>
      </Card>

      <Card
        title="令牌列表"
        extra={
          // ★ 按钮级 RBAC：无 agent:token:manage 时**不渲染**「签发令牌」（docs/09 §9.2）。
          canManage ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setIssueOpen(true);
              }}
            >
              签发令牌
            </Button>
          ) : null
        }
      >
        {state.error !== null ? (
          <Alert type="error" showIcon message={state.error} style={{ marginBottom: 12 }} />
        ) : null}
        <Table<AgentToken>
          rowKey="id"
          size="small"
          loading={state.loading}
          dataSource={state.data?.list ?? []}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "暂无令牌。PiEcho 联调前需先签发一个（docs/09 §10.3 步骤 6）。" }}
        />
      </Card>

      <Modal
        open={issueOpen}
        title="签发 Agent 服务令牌"
        footer={null}
        destroyOnClose
        onCancel={() => {
          setIssueOpen(false);
        }}
      >
        <IssueForm
          endpoints={endpoints}
          onCancel={() => {
            setIssueOpen(false);
          }}
          onIssued={(result) => {
            setIssueOpen(false);
            setIssued(result);
            state.reload();
          }}
        />
      </Modal>

      {issued !== null ? (
        <IssueResultModal
          issued={issued}
          onClose={() => {
            // ★ 先丢弃明文，再让弹窗随 state 消失——关闭后不可再见是结构性的。
            setIssued(null);
          }}
        />
      ) : null}
    </Space>
  );
}
