/**
 * 登录页（`docs/09` §9.1 / `docs/03` §3.5.2）。
 *
 * - 平台入口 → `POST /api/v1/admin/login`；商户入口 → `POST /api/v1/merchant/login`
 * - **TOTP 二次验证**：平台管理员强制（`docs/M0-实施简报` §6.1「平台管理员强制，
 *   商户管理员可选」），故平台入口默认展开验证码输入；商户入口可选填。
 * - 登录失败**不区分**「用户不存在」与「密码错误」（`docs/09` §9.1，防账号枚举）；
 *   连续失败 5 次锁定 15 分钟，界面按 `ACCOUNT_LOCKED` 提示。
 */

import { LockOutlined, SafetyOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Form, Input, Space, Typography } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";

import { ApiError } from "../api/client.js";
import { describeErrorCode } from "../api/errors.js";
import { login } from "../api/services.js";
import type { LoginPayload } from "../api/services.js";
import type { AdminSubject } from "../api/types.js";
import { ENTRY_LABEL } from "../entry.js";
import type { AdminEntry } from "../entry.js";

const { Title, Paragraph, Text } = Typography;

/** 登录表单字段。 */
interface LoginFormValues {
  readonly username: string;
  readonly password: string;
  readonly totpCode?: string;
}

/** 登录页属性。 */
export interface LoginPageProps {
  /** 当前入口（由 hostname 决定）。 */
  readonly entry: AdminEntry;
  /** 登录成功回调（写入会话）。 */
  readonly onSignedIn: (subject: AdminSubject) => void;
}

/** 登录页。 */
export function LoginPage(props: LoginPageProps): ReactNode {
  const { entry, onSignedIn } = props;
  const isPlatform = entry === "platform";
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // 平台入口强制 TOTP：密码校验通过后若后端返回「需要动态验证码」，自动展开输入框。
  const [totpVisible, setTotpVisible] = useState(isPlatform);

  async function handleSubmit(values: LoginFormValues): Promise<void> {
    setSubmitting(true);
    setErrorText(null);
    try {
      const payload: LoginPayload =
        values.totpCode === undefined || values.totpCode.length === 0
          ? { username: values.username, password: values.password }
          : {
              username: values.username,
              password: values.password,
              totpCode: values.totpCode,
            };
      const result = await login(isPlatform, payload);
      onSignedIn(result.subject);
    } catch (cause: unknown) {
      if (cause instanceof ApiError) {
        setErrorText(describeErrorCode(cause.code, cause.message));
        if (cause.code === "TOTP_REQUIRED" || cause.code === "TOTP_INVALID") {
          setTotpVisible(true);
        }
      } else {
        setErrorText("登录失败，请稍后重试");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f5f5",
      }}
    >
      <Card style={{ width: 420 }}>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <div>
            <Title level={3} style={{ marginBottom: 4 }}>
              DShop {ENTRY_LABEL[entry]}
            </Title>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              给 PiEcho 提供 Agent API 的电商后端 · 运营与商户入口
            </Paragraph>
          </div>

          {errorText !== null ? <Alert type="error" showIcon message={errorText} /> : null}

          <Form<LoginFormValues>
            layout="vertical"
            onFinish={(values) => {
              void handleSubmit(values);
            }}
            requiredMark={false}
            initialValues={{ totpCode: "" }}
          >
            <Form.Item
              name="username"
              label="账号"
              rules={[{ required: true, message: "请输入账号" }]}
            >
              <Input prefix={<UserOutlined />} autoComplete="username" placeholder="账号" />
            </Form.Item>

            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                autoComplete="current-password"
                placeholder="密码"
              />
            </Form.Item>

            {totpVisible ? (
              <Form.Item
                name="totpCode"
                label="动态验证码（TOTP）"
                extra={
                  isPlatform
                    ? "平台管理员登录与所有 Agent 令牌签发均强制 TOTP 二次确认（docs/09 §9.2）"
                    : "商户管理员可选（docs/M0-实施简报 §6.1）"
                }
                rules={
                  isPlatform
                    ? [
                        { required: true, message: "请输入 6 位动态验证码" },
                        { len: 6, message: "动态验证码为 6 位" },
                      ]
                    : []
                }
              >
                <Input
                  prefix={<SafetyOutlined />}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 位数字"
                  autoComplete="one-time-code"
                />
              </Form.Item>
            ) : (
              <Button
                type="link"
                size="small"
                style={{ paddingLeft: 0, marginBottom: 12 }}
                onClick={() => {
                  setTotpVisible(true);
                }}
              >
                使用动态验证码登录
              </Button>
            )}

            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form>

          <Text type="secondary" style={{ fontSize: 12 }}>
            两个入口完全隔离：登录接口、Token <Text code>aud</Text> 与权限集互不相同 （docs/03
            §3.5.2）。连续失败 5 次将锁定账号 15 分钟。
          </Text>
        </Space>
      </Card>
    </div>
  );
}
