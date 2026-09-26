/**
 * 应用外壳：导航 + 路由挂载点。
 *
 * ## 渲染模式（**如实说明**）
 *
 * 本项目是 **Vite + React Router 声明式路由的 SPA（CSR）**，
 * **不是** `docs/03` §3.5.1 理想的 React Router v7 framework mode SSR。
 * 降级原因与影响见 `apps/storefront/README.md`「SSR 未落地」一节——
 * **不假装 SSR 已实现**。
 *
 * ## 导航用 `<Link>` 而非 `<a>`
 *
 * 声明式路由下 `<Link>` 才做客户端跳转；用 `<a href>` 会整页刷新，
 * 使「CSR + 状态保持」失去意义。
 */

import type { ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router";

/** 顶部导航项。 */
const NAV_ITEMS: readonly { readonly to: string; readonly label: string }[] = [
  { to: "/", label: "首页" },
  { to: "/search", label: "搜索" },
  { to: "/cart", label: "购物车" },
  { to: "/orders", label: "我的订单" },
  { to: "/aftersales", label: "我的售后" },
  { to: "/policies", label: "售后政策" },
];

/** 单个导航链接。 */
function NavItem({ to, label }: { readonly to: string; readonly label: string }): ReactNode {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded px-3 py-2 text-sm ${isActive ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100"}`
      }
    >
      {label}
    </NavLink>
  );
}

/** 应用外壳（mobile-first：手机上导航横向可滚，桌面展开）。 */
export function AppShell(): ReactNode {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <Link to="/" className="text-lg font-semibold text-gray-900">
            DShop 商城
          </Link>
          <nav className="-mx-1 flex gap-1 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <NavItem key={item.to} to={item.to} label={item.label} />
            ))}
            <NavItem to="/account" label="我的" />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-3 py-4">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-3 pb-8 pt-4 text-xs text-gray-400">
        DShop —— 自营多门店电商（Cloudflare Workers + D1）。见 docs/03-工程结构与前端.md §3.5.1。
      </footer>
    </div>
  );
}

/** 页面标题。 */
export function PageTitle({ children }: { readonly children: ReactNode }): ReactNode {
  return <h1 className="mb-4 text-xl font-semibold text-gray-900">{children}</h1>;
}
