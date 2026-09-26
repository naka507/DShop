# `@dshop/storefront` —— C 端商城前台

DShop 的 C 端（PC / H5 响应式单项目）。职责与页面清单见
[`docs/03-工程结构与前端.md`](../../docs/03-工程结构与前端.md) §3.5.1。

---

## ⚠️ SSR 未落地（如实说明）

`docs/03` §3.5.1 的目标形态是 **React Router v7 framework mode（SSR）**，
浏览类页面（首页 / 分类 / 搜索 / 详情）走 SSR + Cache API 保 SEO 与首屏。

**本版是 Vite + React Router 声明式路由的 SPA（纯 CSR）。**

### 为什么降级

- framework mode 需要 `@react-router/dev` / `@react-router/node` / `@react-router/serve`
  三件套与 `react-router.config.ts` + `app/` 目录约定，并在 Vite 之上接管构建；
- 本任务**禁止执行 `npm install`**（主控独占 lockfile，避免与并行同事冲突），
  因此**无法验证** framework mode 能否离线构建通过——按任务约定
  「宁可诚实降级，也不假装 SSR 已实现」处理。

### 降级带来的**实际损失**（不要当成小事）

| 项           | SSR（目标）                                               | SPA（当前）                                               |
| ------------ | --------------------------------------------------------- | --------------------------------------------------------- |
| SEO          | 首屏 HTML 含商品内容，爬虫可索引                          | 首屏是空 `<div id="root">`，**商品页对爬虫不可见**        |
| 首屏         | 服务端渲染直出                                            | 白屏 → JS 加载 → 请求 → 渲染                              |
| 404 状态码   | 服务端可返回真 404                                        | `src/pages/not-found.tsx` 只能渲染页面，**HTTP 仍是 200** |
| 读路径省一跳 | SSR 可复用 `packages/services` 直连 D1/KV（`docs/03` §3） | 必须走 `/api/v1/shop/*`，多一跳                           |

### 升级路径（后续项）

1. 加依赖 `@react-router/dev`、`@react-router/node`、`@react-router/serve`（或 `@react-router/cloudflare`）；
2. 把 `src/pages/*` 迁到 `app/routes/*`，`src/routes.tsx` 的声明式表换成 framework mode 的
   路由配置（`route()` + `loader`）；
3. 首页 / 分类 / 搜索 / 详情加 `loader` 走服务端取数（可直连 `packages/services`）；
4. 生产入口从「静态资源 Worker」换成带 Service Binding 的 SSR Worker
   （`docs/09` §10.2 的部署顺序：`api → storefront → admin`）。

`src/components/app-shell.tsx`、`src/routes.tsx`、`src/main.tsx` 的文件头注释都标注了当前形态。

---

## 运行

```bash
# 需先在 apps/api 起本地 API（wrangler dev，默认 127.0.0.1:8787）
npm --workspace @dshop/api run dev

npm --workspace @dshop/storefront run dev        # http://127.0.0.1:5173
npm --workspace @dshop/storefront run build
npm --workspace @dshop/storefront run preview    # http://127.0.0.1:4173（同样代理 /api）
npm --workspace @dshop/storefront run typecheck
npm --workspace @dshop/storefront run test
npm --workspace @dshop/storefront run lint
```

## 同源转发铁律（**不可违反**）

`docs/09-认证权限与部署.md` §10.2 + `docs/04` §4.1：

- 前端**一律使用相对路径** `/api/v1/*`；
- dev / preview 由 `vite.config.ts` 代理到 `http://127.0.0.1:8787`；
- 生产由 storefront Worker 用 **Service Binding** 同源转发到 `dshop-api`；
- **绝不用公网绝对 URL fetch**——同 zone 子请求的 Host 头会绕回发起方自己，
  实测表现为**静默 404**。

这条约束已固化成代码：`src/api/transport.ts` 的 `buildUrl()` 对绝对 URL **直接抛错**，
`tests/api-errors.test.ts` 有对应断言。

## 目录结构

```
apps/storefront/
├─ index.html                  SPA 入口
├─ vite.config.ts              React + Tailwind v4 + /api 代理 + vitest 配置
├─ tsconfig.json               extends ../../tooling/tsconfig/react.json
├─ src/
│  ├─ main.tsx                 应用入口（BrowserRouter）
│  ├─ routes.tsx               路由表（对应 docs/03 §3.5.1 页面清单）
│  ├─ styles.css               Tailwind v4 入口
│  ├─ api/
│  │  ├─ errors.ts             ★ shop 组字符串错误码（ERR_SHOP_*）分流
│  │  ├─ transport.ts          ★ 统一响应体解包 + 同源转发铁律 + Idempotency-Key
│  │  ├─ api-client-adapter.ts ★ @dshop/api-client 集成缝（全项目唯一 import 处）
│  │  ├─ client.ts             各 shop 端点封装
│  │  └─ types.ts              C 端视图模型（与 Agent 脱敏契约刻意分离）
│  ├─ order-status/            ★ 升级缝 S4
│  │  ├─ source.ts             OrderStatusSource 抽象（接口本身）
│  │  ├─ polling.ts            S4 默认实现：前端轮询 + 退避 + 不可见暂停
│  │  └─ index.ts              工厂（升级时的唯一切换点）
│  ├─ hooks/                   useAsync / useOrderStatus / useNow
│  ├─ components/              app-shell / ui / order-status-panel
│  ├─ lib/                     format（金额分→元）/ idempotency / markdown
│  └─ pages/                   15 个页面
└─ tests/                      vitest（jsdom + @testing-library/react）
```

## 页面清单

| 域   | 路由                                     | 文件                                                              |
| ---- | ---------------------------------------- | ----------------------------------------------------------------- |
| 浏览 | `/`                                      | `src/pages/home.tsx`                                              |
| 浏览 | `/categories/:id`                        | `src/pages/category.tsx`                                          |
| 浏览 | `/search?q=&sort=&page=`                 | `src/pages/search.tsx`                                            |
| 浏览 | `/products/:spuId`                       | `src/pages/product-detail.tsx`                                    |
| 交易 | `/cart`                                  | `src/pages/cart.tsx`                                              |
| 交易 | `/checkout`                              | `src/pages/checkout.tsx`                                          |
| 交易 | `/pay/:orderNo/result`                   | `src/pages/pay-result.tsx`（**S4 轮询**）                         |
| 会员 | `/login`                                 | `src/pages/login.tsx`                                             |
| 会员 | `/orders`                                | `src/pages/orders.tsx`                                            |
| 会员 | `/orders/:orderNo`                       | `src/pages/order-detail.tsx`（**主单 + 子单状态**）               |
| 会员 | `/aftersales`                            | `src/pages/aftersales.tsx`                                        |
| 会员 | `/aftersales/apply?orderNo=&subOrderNo=` | `src/pages/aftersale-apply.tsx`                                   |
| 会员 | `/aftersales/:aftersaleNo`               | `src/pages/aftersale-detail.tsx`                                  |
| 会员 | `/account`                               | `src/pages/account.tsx`                                           |
| 浏览 | `/policies`                              | `src/pages/policies.tsx`（读 `/api/v1/agent/policies/:category`） |
| —    | `*`                                      | `src/pages/not-found.tsx`                                         |

## 升级缝 S4：订单实时性

`docs/04-Cloudflare资源与升级缝.md` §4.3：

> S4 实时推送：**默认** = 前端轮询（Cache API 防抖）；**升级** = Durable Objects
> WebSocket / SSE，切换方式 = **前端 `OrderStatusSource` 抽象换实现**。

**本版落地的是「默认」**：

- 抽象：`src/order-status/source.ts` 定义 `OrderStatusSource` / `OrderStatusSnapshot`；
- 默认实现：`src/order-status/polling.ts` 的 `PollingOrderStatusSource`
  —— 退避（指数放大、封顶 30s）+ 页面不可见时**完全停表**并广播 `paused` 事件；
- 切换点：`src/order-status/index.ts` 的 `createOrderStatusSource()`；
- 消费方：`src/hooks/use-order-status.ts` → `src/pages/pay-result.tsx`。

**升级到 Durable Objects WebSocket / SSE 时**：新写一个
`implements OrderStatusSource` 的实现，改工厂指向它，**页面与 hook 零改动**。
`src/order-status/` 目录下**不得**出现 `WebSocket` / `EventSource`——默认配置不绑定任何
Durable Object，这是 `docs/04` §4.3 的纪律。

## 测试

```bash
npm --workspace @dshop/storefront run test
```

- `tests/order-status-render.test.tsx` —— **主单 + 每个子单状态都渲染**（`docs/08` §8.3 硬要求）；
- `tests/order-status-polling.test.ts` —— S4 轮询的可见 / 不可见 / 退避行为（手控时钟，不依赖假定时器）；
- `tests/api-errors.test.ts` —— `ERR_SHOP_*` 字符串错误码分流、统一响应体解包、
  `Idempotency-Key`、绝对 URL 拒绝。

## 未实现项（**如实列出**）

| 项                                 | 说明                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSR**                            | 见本文首节；当前为 SPA。                                                                                                                    |
| 收银台页 `/pay/:orderNo`           | `docs/03` §3.5.1 列了该页；本版由支付结果页的「刷新状态」+ `POST /orders/:orderNo/pay` 承担，未单列页面。                                   |
| 支付渠道拉起                       | `payOrder()` 已封装，但微信 / 支付宝 JSAPI 的具体拉起（`docs/08` §8.2）需真实商户参数，未接。                                               |
| 售后凭证上传                       | 文档要求**预签名直传 R2**；预签名端点未在文档中定义，本版只提交 `evidenceKeys`，**不提供上传入口**。                                        |
| 首页 `content_blocks` 楼层 / 轮播  | 读端点未在 `docs/06` §6 定义，首页暂用商品列表。                                                                                            |
| 收藏 `user_favorites`              | `docs/03` §3.5.1 提到该表，但无读端点定义；个人中心只做占位提示，**不伪造数据**。                                                           |
| 地址簿写操作（新增 / 编辑 / 删除） | 仅实现读（`GET /addresses`）；写端点未在 `docs/06` §6 列出。                                                                                |
| TanStack Query                     | 任务标为可选。本版用 `src/hooks/use-async.ts`（少一个依赖 = 少一处 lockfile 冲突面）；升级时 `src/api/client.ts` 的函数可直接作 `queryFn`。 |

## 对外契约（不可破坏）

- 订单号 `^DS\d{17}$`、子单号 `{orderNo}-\d{2}`、售后单号 `^AS\d{11}$`
  （校验一律复用 `@dshop/shared` 的 `ORDER_NO_PATTERN` / `AFTERSALE_NO_PATTERN`，
  不在本包内重写正则）；
- 状态文案一律优先用后端下发的 `statusText`，缺失时用 `@dshop/shared` 的
  `ORDER_STATUS_TEXT` / `SUB_ORDER_STATUS_TEXT` / `AFTERSALE_STATUS_TEXT` 兜底；
- 金额一律是**整数分**，渲染前必须过 `src/lib/format.ts` 的 `formatPrice()`。
