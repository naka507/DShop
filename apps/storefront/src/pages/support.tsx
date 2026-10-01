/**
 * 智能客服整页（`docs/03` §3.5.1 页面清单的「智能客服窗口」行）。
 *
 * 与右下角浮动窗口（`components/support-widget.tsx` 的 `SupportWidget`）
 * 共用同一份 `SupportPanel` 与会话 Hook，只是布局为整页。
 *
 * ## 为什么整页与浮动窗口会同时存在
 *
 * 浮动窗口是全站入口（任意页面可咨询）；整页形态给需要长时间、
 * 大段文字对话的场景。两者**不共享会话状态**（各自挂载一份 Hook），
 * 因此 `/support` 页面里不渲染浮动按钮，避免同屏两份会话互相干扰。
 *
 * ## 依赖边界（如实说明）
 *
 * 客服网关经同源反代访问：dev 由 Vite `supportProxy` 转发到 PiEcho 网关，
 * 生产须由 storefront Worker 用 Service Binding 转发。PiEcho 网关的 CORS
 * **已实现但默认关闭**（未配置 `CORS_ALLOWED_ORIGINS` 时不挂载），且部署形态
 * 尚未定案（PiEcho `docs/09` R24 ②），故当前浏览器仍不可直连其公网端点。
 */

import type { ReactNode } from "react";

import { SupportPanel } from "../components/support-widget.tsx";
import { PageTitle } from "../components/app-shell.tsx";

/** 智能客服整页。 */
export function SupportPage(): ReactNode {
  return (
    <section className="mx-auto max-w-3xl">
      <PageTitle>智能客服</PageTitle>
      <p className="mb-4 text-sm text-gray-500">
        由 PiEcho 客服网关驱动（`docs/11` §14.1：C 端客服窗口归 DShop，PiEcho 只提供服务）。
        订单、商品规格与售后政策类问题会自动查询商城真实数据。
      </p>
      <div className="h-[32rem] overflow-hidden rounded-lg border border-gray-200 bg-white">
        <SupportPanel className="h-full" />
      </div>
      <p className="mt-3 text-xs text-gray-400">
        当前会话 ID 仅存于本机浏览器；用户身份与商城账号的映射尚未约定
        （`docs/11` §15 Q11），故客服侧暂不知道您登录的商城账号。
      </p>
    </section>
  );
}
