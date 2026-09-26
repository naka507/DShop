/**
 * 按钮级 RBAC：无 `aftersale:policy:manage` 权限时「新建政策」按钮**不渲染**。
 *
 * 依据：`docs/09` §9.2——权限点定义在 `packages/shared`，前端按同一权限集
 * 渲染菜单与按钮；后端 `requirePerm()` 做接口级拦截（两层缺一不可）。
 * 权限点取值：`PERMISSIONS.AFTERSALE_POLICY_MANAGE` = `"aftersale:policy:manage"`。
 */

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ADMIN_ENDPOINTS } from "../src/api/endpoints.js";
import { AftersalePoliciesPage } from "../src/pages/AftersalePoliciesPage.js";
import { okEnvelope, renderWithSession, makeSubject, stubFetchByPath } from "./helpers.js";

/** 一条政策，用于断言列表能渲染（页面不崩）。 */
const POLICY_LIST = {
  page: 1,
  pageSize: 20,
  total: 1,
  list: [
    {
      id: "01J9Z8K2M4N5P6Q7R8S9T0P001",
      category: "return",
      title: "七天无理由退货规则",
      content: "正文",
      version: "1.0.0",
      effectiveFrom: "2026-09-20T00:00:00.000Z",
      effectiveTo: null,
      status: "effective",
      tags: ["退货"],
      createdAt: "2026-09-20T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
    },
  ],
};

describe("售后政策管理 · 按钮级 RBAC", () => {
  it("无 aftersale:policy:manage 权限时，「新建政策」按钮不渲染，且给出只读提示", async () => {
    stubFetchByPath({
      [ADMIN_ENDPOINTS.AFTERSALE_POLICIES]: okEnvelope(POLICY_LIST),
    });

    renderWithSession(
      <AftersalePoliciesPage endpoints={ADMIN_ENDPOINTS} />,
      makeSubject({ permissions: [] }),
    );

    // 列表已加载（页面本身可用，只是只读）
    await waitFor(() => {
      expect(screen.getByText("七天无理由退货规则")).toBeTruthy();
    });

    expect(screen.queryByText("新建政策")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
    expect(screen.getByText(/无 aftersale:policy:manage 权限/)).toBeTruthy();
  });

  it("拥有 aftersale:policy:manage 权限时，「新建政策」按钮渲染", async () => {
    stubFetchByPath({
      [ADMIN_ENDPOINTS.AFTERSALE_POLICIES]: okEnvelope(POLICY_LIST),
    });

    renderWithSession(
      <AftersalePoliciesPage endpoints={ADMIN_ENDPOINTS} />,
      makeSubject({ permissions: ["aftersale:policy:manage"] }),
    );

    await waitFor(() => {
      expect(screen.getByText("新建政策")).toBeTruthy();
    });
    // 有权限时不再出现只读提示
    expect(screen.queryByText(/无 aftersale:policy:manage 权限/)).toBeNull();
  });
});
