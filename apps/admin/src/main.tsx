import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("未找到挂载点 #root");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
