/**
 * 应用引导（`docs/03` §3.5.2）。
 *
 * 分流在**应用引导层**：读 `location.hostname` 决定入口与挂载路由组。
 * - `admin.*`    → `/platform/*`（`aud=admin`，平台角色）
 * - `merchant.*` → `/merchant/*`（`aud=merchant`，商户角色）
 *
 * 页面刷新后先调 `GET /me` 恢复会话（Cookie 是 HttpOnly，前端读不到）。
 */

import { ConfigProvider, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { BrowserRouter } from "react-router";

import { fetchMe } from "./api/services.js";
import type { AdminSubject } from "./api/types.js";
import { SessionProvider } from "./auth/session.js";
import { detectEntry } from "./entry.js";
import { AppRoutes } from "./routes.js";

/** 应用根组件。 */
export function App(): ReactNode {
  const entry = detectEntry(window.location.hostname);
  const [subject, setSubject] = useState<AdminSubject | null>(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchMe(entry === "platform")
      .then((me) => {
        if (alive) setSubject(me);
      })
      .catch(() => {
        // 未登录（401）或其它失败：一律按未登录处理，交给登录页。
        if (alive) setSubject(null);
      })
      .finally(() => {
        if (alive) setRestoring(false);
      });
    return () => {
      alive = false;
    };
  }, [entry]);

  const signIn = useCallback((next: AdminSubject) => {
    setSubject(next);
  }, []);

  const signOut = useCallback(() => {
    setSubject(null);
  }, []);

  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <SessionProvider subject={subject} onSignIn={signIn} onSignOut={signOut}>
          {restoring ? (
            <div
              style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Spin tip="正在恢复会话…" />
            </div>
          ) : (
            <AppRoutes entry={entry} />
          )}
        </SessionProvider>
      </BrowserRouter>
    </ConfigProvider>
  );
}
