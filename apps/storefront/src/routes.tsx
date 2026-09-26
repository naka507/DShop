/**
 * 路由表（`docs/03-工程结构与前端.md` §3.5.1 的页面清单）。
 *
 * | 域 | 路由 | 页面 |
 * | --- | --- | --- |
 * | 浏览 | `/` | 首页（商品列表） |
 * | 浏览 | `/categories/:id` | 分类页 |
 * | 浏览 | `/search?q=&sort=&page=` | 搜索列表 |
 * | 浏览 | `/products/:spuId` | 商品详情 |
 * | 交易 | `/cart` | 购物车 |
 * | 交易 | `/checkout` | 结算页 |
 * | 交易 | `/pay/:orderNo/result` | 支付结果（**S4 轮询**） |
 * | 会员 | `/login` | 登录/注册 |
 * | 会员 | `/orders` | 订单列表 |
 * | 会员 | `/orders/:orderNo` | 订单详情（**主单 + 子单状态**） |
 * | 会员 | `/aftersales/apply?orderNo=` | 售后申请 |
 * | 会员 | `/aftersales` | 售后列表 |
 * | 会员 | `/aftersales/:aftersaleNo` | 售后详情 |
 * | 会员 | `/account` | 个人中心 |
 * | 浏览 | `/policies` | 售后政策页（读 `/api/v1/agent/policies/:category`） |
 *
 * `docs/03` §3.5.1 另有 `/pay/:orderNo`（收银台）——本版用支付结果页的
 * 「去支付」按钮触发 `POST /orders/:orderNo/pay`，未单列收银台页
 * （见 README「未实现项」）。
 */

import type { ReactNode } from "react";
import { Route, Routes } from "react-router";

import { AppShell } from "./components/app-shell.tsx";
import { AccountPage } from "./pages/account.tsx";
import { AftersaleApplyPage } from "./pages/aftersale-apply.tsx";
import { AftersaleDetailPage } from "./pages/aftersale-detail.tsx";
import { AftersalesPage } from "./pages/aftersales.tsx";
import { CartPage } from "./pages/cart.tsx";
import { CategoryPage } from "./pages/category.tsx";
import { CheckoutPage } from "./pages/checkout.tsx";
import { HomePage } from "./pages/home.tsx";
import { LoginPage } from "./pages/login.tsx";
import { NotFoundPage } from "./pages/not-found.tsx";
import { OrderDetailPage } from "./pages/order-detail.tsx";
import { OrdersPage } from "./pages/orders.tsx";
import { PayResultPage } from "./pages/pay-result.tsx";
import { PoliciesPage } from "./pages/policies.tsx";
import { ProductDetailPage } from "./pages/product-detail.tsx";
import { SearchPage } from "./pages/search.tsx";

/** 路由定义。 */
export function AppRoutes(): ReactNode {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="categories/:id" element={<CategoryPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="products/:spuId" element={<ProductDetailPage />} />
        <Route path="cart" element={<CartPage />} />
        <Route path="checkout" element={<CheckoutPage />} />
        <Route path="pay/:orderNo/result" element={<PayResultPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="orders/:orderNo" element={<OrderDetailPage />} />
        <Route path="aftersales" element={<AftersalesPage />} />
        <Route path="aftersales/apply" element={<AftersaleApplyPage />} />
        <Route path="aftersales/:aftersaleNo" element={<AftersaleDetailPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="policies" element={<PoliciesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
