/**
 * 应用入口（**SPA / CSR**，见 `README.md` 的「SSR 未落地」一节）。
 *
 * 用 `BrowserRouter` 而非 framework mode 的 `createBrowserRouter`：
 * 声明式路由 + `Routes/Route` 是降级方案的最小形态，与 `src/routes.tsx` 配套。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { AppRoutes } from "./routes.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("找不到挂载节点 #root（见 index.html）");
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>,
);
