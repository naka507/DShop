/**
 * 路由表（`docs/03` §3.5.2）。
 *
 * **挂载路由与入口一一对应**：
 * - 平台入口：`/platform/*`
 * - 商户入口：`/merchant/*`
 *
 * 这里**不使用 `BrowserRouter` 的 `basename`**：入口前缀显式写在路径里，
 * 好处是任一域名下访问不属于自己的入口路径（如商户域下访问 `/platform/*`）
 * 会被通配路由接住并提示，而不是静默渲染空白——与后端 `aud` 校验形成双重拦截。
 *
 * 页面级权限由 `RequirePermission` 按菜单定义的权限点拦截（`docs/09` §9.2）。
 */

import { Alert, Typography } from "antd";
import type { ReactNode } from "react";
import { Route, Routes } from "react-router";

import { endpointsFor, hasAgentEndpoints } from "./api/endpoints.js";
import type { PlatformEndpointSet } from "./api/endpoints.js";
import { useSession } from "./auth/session.js";
import { ENTRY_BASE_PATH } from "./entry.js";
import type { AdminEntry } from "./entry.js";
import {
  AppShell,
  LandingRedirect,
  RequirePermission,
  permissionForPath,
} from "./layout/AppShell.js";
import { AftersaleDetailPage } from "./pages/AftersaleDetailPage.js";
import { AftersalePoliciesPage } from "./pages/AftersalePoliciesPage.js";
import { AftersalesPage } from "./pages/AftersalesPage.js";
import { AgentTokensPage } from "./pages/AgentTokensPage.js";
import { CategoriesPage } from "./pages/CategoriesPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { MerchantsPage } from "./pages/MerchantsPage.js";
import { OrderDetailPage } from "./pages/OrderDetailPage.js";
import { OrdersPage } from "./pages/OrdersPage.js";
import { ProductsPage } from "./pages/ProductsPage.js";
import { StoresPage } from "./pages/StoresPage.js";

const { Text } = Typography;

/** 路由属性。 */
export interface AppRoutesProps {
  readonly entry: AdminEntry;
}

/** 未匹配路由的兜底提示。 */
function NotFound(props: { readonly entry: AdminEntry }): ReactNode {
  const other = props.entry === "platform" ? "/merchant" : "/platform";
  return (
    <Alert
      type="warning"
      showIcon
      message="页面不存在或不属于当前入口"
      description={
        <span>
          当前入口挂载在 <Text code>{ENTRY_BASE_PATH[props.entry]}/*</Text>。
          平台后台与商户后台**完全隔离**：登录接口、Token <Text code>aud</Text> 与权限集互不相同；
          <Text code>{other}/*</Text> 属另一入口，请从左侧菜单进入（docs/03 §3.5.2）。
        </span>
      }
    />
  );
}

/** 平台专属页面的降级提示（商户入口访问 PiEcho 运营入口时）。 */
function PlatformOnly(props: { readonly permission: string }): ReactNode {
  return (
    <Alert
      type="info"
      showIcon
      message="该页面仅在平台后台可用"
      description={
        <span>
          需要权限点 <Text code>{props.permission}</Text>，属平台运营角色（docs/09 §9.2）。
        </span>
      }
    />
  );
}

/** 应用路由。 */
export function AppRoutes(props: AppRoutesProps): ReactNode {
  const { entry } = props;
  const { subject, signIn } = useSession();
  const isPlatform = entry === "platform";
  const base = ENTRY_BASE_PATH[entry];

  // 未登录：只渲染登录页（不渲染任何业务路由）。
  if (subject === null) {
    return <LoginPage entry={entry} onSignedIn={signIn} />;
  }

  const endpoints = endpointsFor(entry);
  // 仅平台入口有 PiEcho 两个运营入口的端点（商户入口无对应权限点）。
  const platformEndpoints: PlatformEndpointSet | null = hasAgentEndpoints(endpoints)
    ? endpoints
    : null;

  return (
    <Routes>
      <Route element={<AppShell entry={entry} />}>
        <Route path={base} element={<LandingRedirect entry={entry} />} />
        {/* 登录后 URL 可能是 `/`：同样交给首页跳转，避免落到通配提示 */}
        <Route path="/" element={<LandingRedirect entry={entry} />} />

        {/* ★ PiEcho 运营入口一：Agent 令牌管理（agent:token:manage） */}
        <Route
          path={`${base}/agent-tokens`}
          element={
            <RequirePermission permission={permissionForPath("/agent-tokens")}>
              {platformEndpoints === null ? (
                <PlatformOnly permission="agent:token:manage" />
              ) : (
                <AgentTokensPage endpoints={platformEndpoints} />
              )}
            </RequirePermission>
          }
        />

        {/* ★ PiEcho 运营入口二：售后政策管理（aftersale:policy:manage） */}
        <Route
          path={`${base}/aftersale-policies`}
          element={
            <RequirePermission permission={permissionForPath("/aftersale-policies")}>
              {platformEndpoints === null ? (
                <PlatformOnly permission="aftersale:policy:manage" />
              ) : (
                <AftersalePoliciesPage endpoints={platformEndpoints} />
              )}
            </RequirePermission>
          }
        />

        <Route path={`${base}/orders`} element={<OrdersPage isPlatform={isPlatform} />} />
        <Route
          path={`${base}/orders/:orderNo`}
          element={<OrderDetailPage isPlatform={isPlatform} />}
        />
        <Route path={`${base}/aftersales`} element={<AftersalesPage isPlatform={isPlatform} />} />
        <Route
          path={`${base}/aftersales/:aftersaleNo`}
          element={<AftersaleDetailPage isPlatform={isPlatform} />}
        />
        <Route path={`${base}/products`} element={<ProductsPage isPlatform={isPlatform} />} />
        <Route path={`${base}/categories`} element={<CategoriesPage isPlatform={isPlatform} />} />
        <Route path={`${base}/merchants`} element={<MerchantsPage isPlatform={isPlatform} />} />
        <Route path={`${base}/stores`} element={<StoresPage isPlatform={isPlatform} />} />

        {/* 兜底：`/` 与另一入口的路径都落这里（不渲染任何业务内容）。 */}
        <Route path="*" element={<NotFound entry={entry} />} />
      </Route>
    </Routes>
  );
}
