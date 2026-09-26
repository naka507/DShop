/**
 * 后台外壳：菜单（**菜单级权限过滤**）+ 顶栏 + 路由守卫（`docs/03` §3.5.2）。
 *
 * 守卫规则（与后端 `aud` 校验双重拦截）：
 * - 未登录 → 渲染登录页（不渲染任何业务页面）
 * - 已登录但访问**无权限**的菜单路径 → 渲染 403 提示，不渲染页面内容
 * - 商户入口访问平台专属路径（`/agent-tokens`、`/aftersale-policies`）→ 视为无权限
 */

import { LogoutOutlined } from "@ant-design/icons";
import { Alert, Button, Layout, Menu, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";

import { PERMISSIONS } from "@dshop/shared";
import type { Permission } from "@dshop/shared";

import { logout } from "../api/services.js";
import { usePermission, useSession } from "../auth/session.js";
import { ENTRY_BASE_PATH, ENTRY_LABEL } from "../entry.js";
import type { AdminEntry } from "../entry.js";
import { MENU_ITEMS, visibleMenuItems } from "./menu.js";

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

/** 页面属性。 */
export interface AppShellProps {
  readonly entry: AdminEntry;
}

/** 外壳组件。 */
export function AppShell(props: AppShellProps): ReactNode {
  const { entry } = props;
  const isPlatform = entry === "platform";
  const navigate = useNavigate();
  const location = useLocation();
  const { subject, signOut } = useSession();
  const { has } = usePermission();

  const items = visibleMenuItems(has, isPlatform);
  const current = MENU_ITEMS.find((item) => location.pathname.includes(item.path));

  async function handleLogout(): Promise<void> {
    try {
      await logout(isPlatform);
    } catch {
      // 退出失败也要清本地会话：Cookie 由后端 /logout 吊销，前端不该卡住用户。
    }
    signOut();
    navigate(ENTRY_BASE_PATH[entry], { replace: true });
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider width={230} theme="light">
        <div style={{ padding: 16 }}>
          <Text strong>DShop {ENTRY_LABEL[entry]}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>
            为 PiEcho 提供 Agent API
          </Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={current === undefined ? [] : [current.path]}
          items={items.map((item) => ({
            key: item.path,
            // 菜单路径带上入口前缀（`/platform/*` 或 `/merchant/*`，docs/03 §3.5.2）
            label: <Link to={`${ENTRY_BASE_PATH[entry]}${item.path}`}>{item.label}</Link>,
          }))}
        />
      </Sider>

      <Layout>
        <Header
          style={{
            background: "#fff",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingInline: 16,
          }}
        >
          <Space>
            <Text>{current?.label ?? "后台"}</Text>
            <Tag color={isPlatform ? "blue" : "green"}>{ENTRY_LABEL[entry]}</Tag>
          </Space>
          <Space>
            <Text type="secondary">
              {subject?.nickname ?? ""}（{subject?.username ?? ""}）
            </Text>
            <Button
              size="small"
              icon={<LogoutOutlined />}
              onClick={() => {
                void handleLogout();
              }}
            >
              退出
            </Button>
          </Space>
        </Header>

        <Content style={{ padding: 16 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

/**
 * 路由守卫：按菜单定义所需的权限点拦截页面。
 *
 * 权限点缺失时**不渲染页面内容**（与按钮级隐藏同源，`docs/09` §9.2）。
 */
export function RequirePermission(props: {
  readonly permission: Permission | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const { permission, children } = props;
  const { has } = usePermission();
  if (permission !== undefined && !has(permission)) {
    return (
      <Alert
        type="error"
        showIcon
        message="无权限访问该页面"
        description={
          <span>
            当前账号缺少权限点 <Text code>{permission}</Text>。前端拦截与后端{" "}
            <Text code>requirePerm()</Text> 是双重保障（docs/09 §9.2）。
          </span>
        }
      />
    );
  }
  return children;
}

/**
 * 首页：按权限点跳转到第一个可见菜单。
 *
 * 跳转目标带入口前缀（`/platform/*` 或 `/merchant/*`，`docs/03` §3.5.2）。
 */
export function LandingRedirect(props: { readonly entry: AdminEntry }): ReactNode {
  const { entry } = props;
  const { has } = usePermission();
  const navigate = useNavigate();
  const items = visibleMenuItems(has, entry === "platform");
  const first = items[0];

  if (first === undefined) {
    return (
      <Alert
        type="warning"
        showIcon
        message="当前账号没有任何可见菜单"
        description="请确认角色权限集是否包含 packages/shared/src/rbac.ts 中的权限点（docs/09 §9.2）。"
      />
    );
  }

  // 用 replace 避免首页堆积历史记录。
  navigate(`${ENTRY_BASE_PATH[entry]}${first.path}`, { replace: true });
  return null;
}

/** 供 `RequirePermission` 使用：从菜单定义取该路径所需权限点。 */
export function permissionForPath(path: string): Permission | undefined {
  const item = MENU_ITEMS.find((m) => m.path === path);
  return item?.permission;
}

/** 供测试断言：导出关键权限点常量。 */
export const ADMIN_PERMISSIONS = PERMISSIONS;
