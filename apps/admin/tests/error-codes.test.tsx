/**
 * 错误码分流（`docs/06` §6）。
 *
 * 规则逐字来自文档：**整数错误码仅用于 `/api/v1/agent/*`；
 * 字符串错误码仅用于 shop / admin / merchant 三组，两组不混用**。
 *
 * 本用例同时覆盖：
 * 1. `classifyErrorCode()` 的纯函数分流
 * 2. `ApiError` 的 `isUnauthorized` / `isForbidden` 判定
 * 3. 页面把后台组字符串码渲染成中文文案（而非把码直接抛给用户）
 */

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApiError } from "../src/api/client.js";
import { ADMIN_ENDPOINTS } from "../src/api/endpoints.js";
import {
  ADMIN_ERROR_CODES,
  ADMIN_ERROR_TEXT,
  classifyErrorCode,
  describeErrorCode,
  isKnownAdminErrorCode,
  isOkCode,
} from "../src/api/errors.js";
import { AftersalePoliciesPage } from "../src/pages/AftersalePoliciesPage.js";
import { errorEnvelope, makeSubject, renderWithSession, stubFetchByPath } from "./helpers.js";

describe("错误码分流 · 纯函数", () => {
  it('成功码：整数 0、字符串 "0"、"OK" 都视为成功', () => {
    expect(isOkCode(0)).toBe(true);
    expect(isOkCode("0")).toBe(true);
    expect(isOkCode(ADMIN_ERROR_CODES.OK)).toBe(true);
    expect(isOkCode("INVALID_PARAM")).toBe(false);
    expect(classifyErrorCode(0)).toBe("ok");
    expect(classifyErrorCode("OK")).toBe("ok");
  });

  it("字符串码 → 后台组（admin）；整数码 → Agent 组（agent）", () => {
    expect(classifyErrorCode("FORBIDDEN")).toBe("admin");
    expect(classifyErrorCode(ADMIN_ERROR_CODES.ORDER_STOCK_NOT_ENOUGH)).toBe("admin");
    // Agent 组的整数码（packages/shared/src/errors.ts 的 AGENT_ERROR_CODES）
    expect(classifyErrorCode(40101)).toBe("agent");
    expect(classifyErrorCode(42901)).toBe("agent");
  });

  it("已登记的后台组字符串码有中文文案；未知码回落后端 message", () => {
    expect(isKnownAdminErrorCode(ADMIN_ERROR_CODES.FORBIDDEN)).toBe(true);
    expect(isKnownAdminErrorCode("SOMETHING_ELSE")).toBe(false);

    expect(describeErrorCode(ADMIN_ERROR_CODES.FORBIDDEN, "ignored")).toBe(
      ADMIN_ERROR_TEXT[ADMIN_ERROR_CODES.FORBIDDEN],
    );
    expect(describeErrorCode("SOMETHING_ELSE", "后端说明")).toBe("后端说明");
    expect(describeErrorCode("SOMETHING_ELSE")).toBe("请求失败");
  });

  it("ApiError 的 isUnauthorized / isForbidden 按后台组字符串码与 HTTP 状态判定", () => {
    expect(new ApiError(ADMIN_ERROR_CODES.UNAUTHORIZED, "未登录").isUnauthorized).toBe(true);
    expect(new ApiError(ADMIN_ERROR_CODES.TOKEN_MISSING_OR_INVALID, "未登录").isUnauthorized).toBe(
      true,
    );
    expect(new ApiError("INTERNAL_ERROR", "x", 401).isUnauthorized).toBe(true);

    expect(new ApiError(ADMIN_ERROR_CODES.FORBIDDEN, "无权").isForbidden).toBe(true);
    expect(new ApiError("INTERNAL_ERROR", "x", 403).isForbidden).toBe(true);

    expect(new ApiError("INTERNAL_ERROR", "x").isUnauthorized).toBe(false);
    // 整数码属 Agent 组，不应被后台判定为「未登录」
    expect(new ApiError(40101, "agent 组").isUnauthorized).toBe(false);
  });
});

describe("错误码分流 · 页面渲染", () => {
  it("接口返回后台组字符串码 FORBIDDEN 时，页面展示中文文案而非裸码", async () => {
    stubFetchByPath({
      [ADMIN_ENDPOINTS.AFTERSALE_POLICIES]: errorEnvelope(ADMIN_ERROR_CODES.FORBIDDEN),
    });

    renderWithSession(
      <AftersalePoliciesPage endpoints={ADMIN_ENDPOINTS} />,
      makeSubject({ permissions: ["aftersale:policy:manage"] }),
    );

    await waitFor(() => {
      expect(screen.getByText(ADMIN_ERROR_TEXT[ADMIN_ERROR_CODES.FORBIDDEN])).toBeTruthy();
    });
  });

  it("接口返回未知字符串码时，页面回落展示后端 message", async () => {
    stubFetchByPath({
      [ADMIN_ENDPOINTS.AFTERSALE_POLICIES]: errorEnvelope("POLICY_CACHE_STALE", "边缘缓存未失效"),
    });

    renderWithSession(
      <AftersalePoliciesPage endpoints={ADMIN_ENDPOINTS} />,
      makeSubject({ permissions: ["aftersale:policy:manage"] }),
    );

    await waitFor(() => {
      expect(screen.getByText("边缘缓存未失效")).toBeTruthy();
    });
  });
});
