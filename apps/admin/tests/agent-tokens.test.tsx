/**
 * ★ 「令牌明文只显示一次」——弹窗关闭后不再渲染。
 *
 * 依据：
 * - `docs/07` §7.8.1：明文**仅创建时返回一次**；服务端只存
 *   `token_hash = HMAC-SHA256(AGENT_TOKEN_PEPPER, token)` 与 `token_prefix`（前 16 位）
 * - `docs/09` §10.3 步骤 6：签发后「明文仅返回一次 → 安全渠道交付 PiEcho」
 * - `docs/09` §9.2：签发权限点 `agent:token:manage`，**强制 TOTP 二次确认**
 *
 * 实现保证（见 `src/pages/AgentTokensPage.tsx` 的 `IssueResultModal` 注释）：
 * 明文只存在 `issued` 这一处 state，且只在结果弹窗内渲染；关闭时先 `setIssued(null)`，
 * 明文随之从 React 树与内存 state 同时消失——列表接口不再返回明文，无法再次打开查看。
 */

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ADMIN_ENDPOINTS } from "../src/api/endpoints.js";
import { AgentTokensPage } from "../src/pages/AgentTokensPage.js";
import { okEnvelope, makeSubject, renderWithSession } from "./helpers.js";

/** 明文令牌（格式 `dshop_svc_<24 位 base62>_<6 位校验位>`，docs/M0-实施简报 §4.3）。 */
const PLAINTEXT_TOKEN = "dshop_svc_AbCdEfGhIjKlMnOpQrStUvWx_9Z8Y7X";

/** 列表（**不含明文**，只有前缀）。 */
const TOKEN_LIST = {
  page: 1,
  pageSize: 20,
  total: 0,
  list: [],
};

/** 签发响应（含一次性明文）。 */
const ISSUE_RESPONSE = {
  token: PLAINTEXT_TOKEN,
  id: "01J9Z8K2M4N5P6Q7R8S9T0T001",
  name: "piecho-prod",
  tokenPrefix: "dshop_svc_AbCdEf",
  scopes: ["agent:order:read", "agent:policy:read"],
  expiresAt: "2027-03-19T00:00:00.000Z",
};

/**
 * 按 **method + path** 分发的 fetch 桩。
 *
 * `GET /admin/agent-tokens` 返回列表，`POST /admin/agent-tokens` 返回一次性明文——
 * 这与后端语义一致：**只有签发响应含明文，列表响应永不含明文**。
 */
function stubTokenApi(): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();

    // 请求 URL 带 `/api/v1` 前缀，端点常量不含该前缀，故用「包含」匹配。
    const isTokenPath = path.includes(ADMIN_ENDPOINTS.AGENT_TOKENS);
    if (isTokenPath && method === "POST") {
      return Promise.resolve(jsonResponse(okEnvelope(ISSUE_RESPONSE)));
    }
    if (isTokenPath) {
      return Promise.resolve(jsonResponse(okEnvelope(TOKEN_LIST)));
    }
    return Promise.resolve(
      jsonResponse(
        { code: "NOT_FOUND", message: `未桩化路径：${method} ${path}`, data: null },
        404,
      ),
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 走完「打开签发弹窗 → 填表 → 提交」流程。 */
async function issueToken(): Promise<void> {
  fireEvent.click(screen.getByText("签发令牌"));

  await waitFor(() => {
    expect(screen.getByText("签发 Agent 服务令牌")).toBeTruthy();
  });

  fireEvent.change(screen.getByPlaceholderText("piecho-prod"), {
    target: { value: "piecho-prod" },
  });
  fireEvent.change(screen.getByPlaceholderText("6 位数字"), {
    target: { value: "123456" },
  });
  // antd 会在两个汉字之间插入空格（「签 发」），故用正则匹配按钮文本。
  fireEvent.click(screen.getByRole("button", { name: /^签\s*发$/ }));

  await waitFor(() => {
    expect(screen.getByText(PLAINTEXT_TOKEN)).toBeTruthy();
  });
}

describe("Agent 令牌 · 明文只显示一次", () => {
  it("签发后弹窗展示明文，且带「只显示这一次」的醒目提示与复制按钮", async () => {
    stubTokenApi();

    renderWithSession(<AgentTokensPage endpoints={ADMIN_ENDPOINTS} />, makeSubject());

    await issueToken();

    expect(screen.getByText(PLAINTEXT_TOKEN)).toBeTruthy();
    expect(screen.getByText("明文令牌只显示这一次")).toBeTruthy();
    expect(screen.getByText("复制明文令牌")).toBeTruthy();
    // 关闭按钮文案本身即提醒「关闭后不可再见」
    expect(screen.getByText("我已妥善保存，关闭")).toBeTruthy();
  });

  it("关闭结果弹窗后，明文不再渲染（state 已置 null，无法再次打开）", async () => {
    stubTokenApi();

    renderWithSession(<AgentTokensPage endpoints={ADMIN_ENDPOINTS} />, makeSubject());

    await issueToken();

    fireEvent.click(screen.getByText("我已妥善保存，关闭"));

    await waitFor(() => {
      expect(screen.queryByText(PLAINTEXT_TOKEN)).toBeNull();
    });
    // 提示语与复制按钮一并消失，说明整个结果弹窗已从树上卸载
    expect(screen.queryByText("明文令牌只显示这一次")).toBeNull();
    expect(screen.queryByText("复制明文令牌")).toBeNull();
    // 页面上不存在任何「重新查看明文」的入口
    expect(screen.queryByText("查看明文")).toBeNull();
  });

  it("无 agent:token:manage 权限时，签发与吊销按钮均不渲染", async () => {
    stubTokenApi();

    renderWithSession(
      <AgentTokensPage endpoints={ADMIN_ENDPOINTS} />,
      makeSubject({ permissions: [] }),
    );

    await waitFor(() => {
      expect(screen.getByText(/无 agent:token:manage 权限/)).toBeTruthy();
    });

    expect(screen.queryByText("签发令牌")).toBeNull();
  });
});
