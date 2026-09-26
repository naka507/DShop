/**
 * 测试辅助：渲染页面 + 桩化会话与 fetch。
 *
 * 所有页面都依赖 `SessionProvider`（RBAC）与统一响应体（`docs/06` §6），
 * 这里把两者收敛成两个小工具，避免每个用例重复搭架子。
 */

import { render } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";

import type { AdminSubject } from "../src/api/types.js";
import { SessionProvider } from "../src/auth/session.js";

/** 构造后台主体（默认平台超管权限集，`packages/shared/src/rbac.ts` 的全集）。 */
export function makeSubject(overrides: Partial<AdminSubject> = {}): AdminSubject {
  return {
    id: "01J9Z8K2M4N5P6Q7R8S9T0AD01",
    username: "admin",
    nickname: "平台超管",
    aud: "admin",
    role: "platform_super_admin",
    roles: ["platform_super_admin"],
    permissions: [
      "merchant:approve",
      "product:review",
      "order:ship",
      "aftersale:approve",
      "settlement:confirm",
      "agent:token:manage",
      "aftersale:policy:manage",
    ],
    merchantIds: [],
    ...overrides,
  };
}

/** 在 `SessionProvider` 中渲染。 */
export function renderWithSession(
  ui: ReactElement,
  subject: AdminSubject | null = makeSubject(),
): RenderResult {
  const noop = (): void => undefined;
  return render(
    <SessionProvider subject={subject} onSignIn={noop} onSignOut={noop}>
      {ui as ReactNode}
    </SessionProvider>,
  );
}

/** 统一响应体（成功）。 */
export function okEnvelope<T>(data: T): {
  code: string;
  message: string;
  data: T;
} {
  return { code: "OK", message: "ok", data };
}

/** 统一响应体（失败，后台组字符串码，`docs/06` §6）。 */
export function errorEnvelope(
  code: string,
  message = "",
): {
  code: string;
  message: string;
  data: null;
} {
  return { code, message, data: null };
}

/**
 * 按请求路径分发响应。
 *
 * 每个路由返回一个 JSON 对象；未命中的路径返回 404 + `NOT_FOUND`，
 * 让「测试忘了桩某接口」变成显式失败而不是静默通过。
 */
export function stubFetchByPath(
  routes: Readonly<Record<string, unknown>>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    // 请求 URL 带 `/api/v1` 前缀，而端点常量不含该前缀，故用「包含」匹配。
    const matched = Object.entries(routes).find(([key]) => path.includes(key));
    if (matched === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify(errorEnvelope("NOT_FOUND", `未桩化路径：${path}`)), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(matched[1]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
