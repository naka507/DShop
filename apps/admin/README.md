# @dshop/admin —— 运营 / 商户后台

> 权威来源：`docs/03-工程结构与前端.md` §3.5.2「后台『一个应用、两个入口』」、
> `docs/09-认证权限与部署.md` §9.1–§9.2、`docs/06-API路由命名空间.md` §6。

## 职责

DShop 的**第一职责**是给 PiEcho（AI 客服）提供 Agent API。本应用承载 PiEcho 的
**两个运营入口**（`docs/09` §9.2 末尾强调：M0 必须有后台入口，否则 PiEcho 拿不到令牌、
政策语料无法维护，联调无法开始）：

| 页面           | 接口                                                                            | 权限点                    | 文档                       |
| -------------- | ------------------------------------------------------------------------------- | ------------------------- | -------------------------- |
| Agent 令牌管理 | `POST /api/v1/admin/agent-tokens`、`POST /api/v1/admin/agent-tokens/:id/revoke` | `agent:token:manage`      | 09 §10.3 步骤 6、07 §7.8.1 |
| 售后政策管理   | `POST /api/v1/admin/aftersale-policies`                                         | `aftersale:policy:manage` | 07 §7.7、09 §9.2           |

## 两个入口（同构建产物，按 hostname 分流）

| hostname                     | 入口     | 挂载路由      | Token `aud` |
| ---------------------------- | -------- | ------------- | ----------- |
| `admin.dshop.example.com`    | 平台后台 | `/platform/*` | `admin`     |
| `merchant.dshop.example.com` | 商户后台 | `/merchant/*` | `merchant`  |

分流在应用引导层（`src/entry.ts` 的 `detectEntry(location.hostname)`），**不做 UA 跳转、
不做两套构建**。任一域名下访问不属于自己的路由 → 前端重定向 + 后端 `aud` 校验双重拦截。

## 硬性约束

- **API 一律相对路径 `/api/v1/*`**；生产由 Worker 侧 Service Binding 同源转发到 `dshop-api`
  （`docs/04` §4.1），**绝不用公网绝对 URL fetch**。本地开发走 Vite proxy → `127.0.0.1:8787`。
- 静态资产由 Workers Assets 托管（SPA fallback）。
- 后台组响应体 `code` 是**字符串**错误码；Agent 组才是整数码，两组不混用（`docs/06` §6）。
  见 `src/api/errors.ts` 的 `classifyErrorCode()`。

## 脚本

```bash
npm --workspace @dshop/admin run dev        # Vite dev server（:5174，/api 代理到 :8787）
npm --workspace @dshop/admin run build      # 产出 dist/
npm --workspace @dshop/admin run typecheck  # tsc --noEmit
npm --workspace @dshop/admin run test       # vitest run
npm --workspace @dshop/admin run lint       # eslint src tests
```

## 目录

```
src/
├─ entry.ts             # hostname → 入口（platform / merchant）
├─ main.tsx             # 应用引导
├─ App.tsx              # ConfigProvider + Session + Router
├─ routes.tsx           # 两入口路由表
├─ api/
│  ├─ client.ts         # ★ @dshop/api-client 的唯一适配点 + 信封解包 + ApiError
│  ├─ endpoints.ts      # 端点定义（相对路径）
│  ├─ errors.ts         # 后台组字符串错误码表 + 错误码分流
│  └─ types.ts          # 后台视图类型
├─ auth/
│  └─ session.tsx       # SessionProvider / useSession / usePermission（RBAC）
├─ layout/
│  ├─ menu.ts           # 菜单定义（含权限点）
│  └─ AppShell.tsx      # 菜单级权限过滤 + 路由守卫
├─ pages/               # 页面
└─ utils/format.ts      # 金额（分）/ 时间（UTC ISO）格式化
tests/                  # vitest + jsdom
```
