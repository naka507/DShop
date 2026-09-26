# DShop

自营多门店电商平台（Cloudflare Workers + Hono + Drizzle + D1）。
同时是 **PiEcho 智能客服的业务事实来源**：PiEcho 通过只读 Agent API 查询订单、商品、售后与政策。

> **当前阶段：M0（骨架与契约冻结）**
> 交付范围见 [`docs/M0-实施简报.md`](docs/M0-实施简报.md)；41 表逐列定义见 [`docs/M0-字段契约.md`](docs/M0-字段契约.md)。

---

## 1. 仓库结构

```
DShop/
├── apps/
│   └── api/                    Cloudflare Worker（Hono 入口）
│       ├── src/
│       │   ├── index.ts            应用入口、/health、notFound/onError
│       │   ├── env.ts              Env 绑定类型（DB / DO / 各密钥）
│       │   ├── durable-objects/    AgentRateLimiter（全局精确限流）
│       │   ├── lib/                上下文、错误信封、状态中文文案
│       │   ├── middleware/         request-id / 契约版本 / 鉴权 / scope / 限流 / RBAC
│       │   ├── repositories/       原生 D1 查询（显式列清单，无 SELECT *）
│       │   └── routes/
│       │       ├── agent/          Agent 只读六端点（GET-only）
│       │       └── admin/          后台登录 / 刷新 / 登出 / me
│       └── wrangler.jsonc
├── packages/
│   ├── shared/                 ★ 契约中心（Zod Schema / 枚举 / 错误码 / 单号 / RBAC）
│   ├── db/                     41 表 Drizzle schema + D1 迁移
│   ├── auth/                   WebCrypto：JWT / PBKDF2 / TOTP / 服务令牌 / PII
│   └── services/               脱敏器 / 订单状态聚合 / 库存 / 限流 / 契约版本
├── data/
│   └── seed-cs/                客服场景数据集（虚构，仅 dev/staging）
├── scripts/                    仓库级工具（tsx 运行）
└── docs/                       设计文档 + 本阶段交付物
```

**依赖方向（单向，禁止反向）**：

```
shared  →  auth  →  services  →  api
                 ↘   db      ↗
```

---

## 2. 技术栈与编译基线

| 项         | 取值                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| 运行时     | Cloudflare Workers（**只能用 WebCrypto / TextEncoder / atob / btoa**；禁止 `node:crypto`、`Buffer`、`process`） |
| Web 框架   | Hono                                                                                                            |
| ORM / 迁移 | Drizzle ORM + drizzle-kit                                                                                       |
| 数据库     | Cloudflare D1                                                                                                   |
| 包管理     | **npm workspaces**（非 pnpm）                                                                                   |
| 构建编排   | Turborepo                                                                                                       |
| 语言       | TypeScript **strict**                                                                                           |

所有包共同遵守：

- `strict: true` + `noUncheckedIndexedAccess: true` + `verbatimModuleSyntax: true`（类型导入必须 `import type`）
- `moduleResolution: "Bundler"` + `module: "ESNext"`
- **包内相对导入必须带 `.js` 后缀**

---

## 3. 快速开始

```bash
npm install                      # 根目录一次装齐（workspaces）

npm run typecheck                # 全工作区 tsc --noEmit
npm test                         # 全工作区 vitest
npm run lint                     # eslint

npm run openapi                  # 重新导出 docs/openapi/agent.v1.json
npm run seed:sql                 # 由 data/seed-cs/*.json 重建 seed_cs.sql
npm run check                    # 聚合自检（tsc + vitest + 种子校验）
```

本地起服务与灌数据：

```bash
npx tsx scripts/load-seed-local.ts     # 迁移 + 种子 → 本地 D1（无外部副作用）
npx wrangler dev --config apps/api/wrangler.jsonc
```

> ⚠️ `load-seed-local.ts --remote` 会写**真实 D1**，M0 阶段禁止对生产使用。
> `data/seed-cs/` 是虚构数据，生产环境不得导入。

---

## 4. Agent API（只读六端点）

契约版本载体：请求头 `X-Contract-Version`（缺失视为 `1`，不报错；显式不支持 → `400` + `40010`）。

| 方法 | 路径                                    | Scope                  | 限流/min | 缓存 TTL |
| ---- | --------------------------------------- | ---------------------- | -------- | -------- |
| GET  | `/api/v1/agent/orders/:orderNo`         | `agent:order:read`     | 120      | 10s      |
| GET  | `/api/v1/agent/orders`                  | `agent:order:read`     | 120      | 10s      |
| GET  | `/api/v1/agent/products/:spuId/specs`   | `agent:product:read`   | 300      | 60s      |
| GET  | `/api/v1/agent/products/:spuId/stock`   | `agent:product:read`   | 300      | 30s      |
| GET  | `/api/v1/agent/aftersales/:aftersaleNo` | `agent:aftersale:read` | 120      | 10s      |
| GET  | `/api/v1/agent/policies/:category`      | `agent:policy:read`    | 60       | 300s     |

- **仅 GET**。非 GET 请求在鉴权**之前**即返回 `405` + `40501`。
- 鉴权头：`X-Service-Token`（**非** Bearer，不允许放 query string）。
- 响应统一信封 `{ code, message, data }`；`requestId` 只走 `X-Request-Id` 响应头。
- 完整定义：[`docs/openapi/agent.v1.json`](docs/openapi/agent.v1.json)（由 `packages/shared` 的 Zod Schema 生成，**请勿手改**）。

### 契约锁（跨仓库）

`packages/shared/tests/agent-contract.test.ts` 用 **PiEcho 侧 12 个真实 fixture**
（`packages/shared/tests/fixtures/pi-echo/`）反向校验本仓库的 Zod Schema。

截至 M0：**12/12 全部匹配，零不匹配、零缺失字段**。
PiEcho 侧 fixture 一旦变更，该测试立即失败——这是「响应形状逐字对齐 PiEcho」的可执行证据。

---

## 5. 关键约定

| 项           | 约定                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| 金额         | **整数分**（绝不用浮点）                                                                           |
| 时间         | **ISO-8601 UTC**                                                                                   |
| 主键         | **ULID 26 位**                                                                                     |
| 单号         | `order_no` `^DS\d{17}$`、`sub_order_no` `^DS\d{17}-\d{2}$`、`aftersale_no` `^AS\d{11}$`            |
| **时区陷阱** | 单号内嵌时间戳是 **UTC+8**，时间字段是 **UTC**。`DS20260920143000123` ⇔ `2026-09-20T06:30:00.000Z` |
| 主单状态     | 由子单**聚合**得出（先剔除 `CANCELLED`）                                                           |
| 库存         | 可售 = `stock - locked_stock`；下单只锁定，支付成功实扣，取消只释放                                |
| 脱敏         | 手机号 `138****8888`、姓名 `张**`、地址以 `***` 结尾；禁出字段白名单+黑名单双保险                  |
| 数据表       | 41 张；权限点存 `roles.permissions`（**无** `permissions`/`role_permissions` 表）                  |

文档未定义处由实现侧拍板并**登记**在 [`docs/M0-字段契约.md`](docs/M0-字段契约.md) §13。

---

## 6. 文档导航

| 文档                                                       | 内容                            |
| ---------------------------------------------------------- | ------------------------------- |
| [`docs/README.md`](docs/README.md)                         | 设计文档总索引                  |
| [`docs/M0-实施简报.md`](docs/M0-实施简报.md)               | M0 交付范围与验收口径           |
| [`docs/M0-字段契约.md`](docs/M0-字段契约.md)               | 41 表逐列定义 + 实现侧定案登记  |
| [`docs/openapi/agent.v1.json`](docs/openapi/agent.v1.json) | Agent API OpenAPI 3.1（生成物） |
| [`scripts/README.md`](scripts/README.md)                   | 工具脚本用法与定案              |
| [`data/seed-cs/README.md`](data/seed-cs/README.md)         | 客服场景数据集说明              |

---

## 7. 环境变量

| 变量                      | 用途                                                     | 开发默认值                     | 生产         |
| ------------------------- | -------------------------------------------------------- | ------------------------------ | ------------ |
| `JWT_SECRET`              | 后台 JWT（HS256）签名                                    | 开发默认                       | **必须注入** |
| `AGENT_TOKEN_PEPPER`      | `service_tokens.token_hash = HMAC-SHA256(pepper, token)` | `dshop-dev-agent-token-pepper` | **必须注入** |
| `PHONE_ENC_KEY`           | `users.phone` 的 AES-256-GCM 密钥材料                    | `dshop-dev-phone-enc-key`      | **必须注入** |
| `PHONE_HASH_PEPPER`       | `users.phone_hash` 的 HMAC-SHA256 胡椒                   | `dshop-dev-phone-hash-pepper`  | **必须注入** |
| `AGENT_REQUIRE_SIGNATURE` | 是否强制请求签名（默认关闭）                             | `false`                        | 按需         |

> 开发默认值**仅用于 dev/staging**；生产必须用 `wrangler secret put` 注入真实值后重新生成派生数据。
