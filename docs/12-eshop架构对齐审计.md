# 12 · eshop 参考架构全解与 DShop 对齐审计

> **状态**：v2.1（彻底版 + 配置面全清点）｜ **审计对象**：`E:\Code\eshop`（伙伴项目，通用商城）
> **审计口径**：读**文档 + 配置 + 技术栈清单 + 接口签名**，**不读业务实现细节**（用户明确要求）。
> **结论用途**：DShop 重写的架构依据。DShop 为独立设计，**不复用 eshop 任何代码**（`docs/02:10`），仅对齐其**架构纪律**。

---

## 12.0 审计方法与证据基线

| 项                                                   | 实测值                                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库文件数（`git ls-files`，排除 node_modules/.git/构建产物） | 172                                                                                                    |
| 文档                                                 | `docs/system-design.md`（**638 行 / 49,585 字节**，唯一设计文档，头部标 v0.4、正文含 v0.5 变更）、`README.md`（**105 行**）、`tools/svg/README.md`                                                   |
| 配置                                                 | 3 份 wrangler、根 `package.json`/`turbo.json`/`pnpm-workspace.yaml`/`eslint.config.js`/`.prettierrc.json`/`.gitignore`、`tooling/*`、7 份包 manifest、3 份前端构建配置 |
| 数据库                                               | `packages/db/migrations/0000_clean_peter_quill.sql`（**444 行，31 CREATE TABLE**）+ 0001（1 表）= **全仓 32 表**；索引 **57 个**；0002_seed 为 DML（**不在 journal 内**）；0003–0006 为 DDL 增量；`meta/` 仅 4 份 snapshot |
| 代码                                                 | 仅读**文件清单、行数、接口签名、路由挂载点、env 类型**，未逐行阅读业务逻辑                                                                                             |

> **v2.1 相对 v2.0 的变更（本轮）**：审计范围从「文档 + 少量配置」扩到 **eshop 全部 172 个受跟踪文件的配置面逐字清点**（9 份 `package.json`、`turbo.json`、`pnpm-workspace.yaml`、`tooling/{tsconfig,eslint}`、3 份 wrangler、CI、drizzle/vite/react-router 配置、迁移 journal）。据此**修正 v2.0 的 6 处事实错误**（`ls-files` 171→**172**、README 65→**105 行**、0000 迁移 445→**444 行**且 32→**31 表**、routes 20→**21 个扁平文件**、索引 53→**57 个**、`packages/shared` 模块数），并**新增 E37–E51（15 条配置面不一致）**，把 eshop 内部不一致总数从 36 条扩到 **51 条**。另**证伪**两条镜像伪影结论（`.dev.vars` 未被跟踪、商品图并未缺失）。
>
> **v2.0 相对 v1.0 的变更**：补齐 eshop **全部三份 wrangler 配置原文**、**全部包 manifest**、**Cron 单一入口机制**、**统一响应体与错误码实测形态**、**免费层边界逐条对照**、**CI/CD 流水线实测对照**、**环境策略**，并把偏离清单从 13 条收敛为**可执行的 10 项 + 已达标 8 项**。

---

## 12.1 技术栈（实测，非文档声称）

| 维度     | eshop 实测                                          | 证据                                                                                     |
| -------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 包管理   | **pnpm@12.4.1**                                     | 根 `package.json` `packageManager`                                                       |
| 工作区   | `apps/*` + `packages/*` + `tooling/*`               | `pnpm-workspace.yaml`                                                                    |
| Node     | `>=20`                                              | 根 `package.json` `engines`                                                              |
| 构建编排 | **turbo ^2.3.0**                                    | 根 devDeps；`turbo.json` **6 个 task**：`build`/`dev`/`lint`/`typecheck`/`test`/`deploy` |
| 语言     | TypeScript **^5.6.0**                               | 根 devDeps                                                                               |
| 静态检查 | ESLint **^9.0.0** + `@typescript-eslint` **^8.0.0** | 根 devDeps；`eslint.config.js` 为 flat config                                            |
| 格式化   | **Prettier ^3.3.0**                                 | 根 devDeps + `.prettierrc.json` + `npm run format`                                       |
| 模块制式 | **ESM**（`"type": "module"`）                       | 根 `package.json`                                                                        |
| 后端框架 | **Hono 4**                                          | `apps/api`                                                                               |
| C 端     | **React Router v7 SSR** + **Tailwind v4**           | `apps/storefront`（`react-router.config.ts` `ssr: true`）                                |
| 后台     | **Vite + React SPA**                                | `apps/admin`                                                                             |
| ORM      | **Drizzle**（sqlite dialect）                       | `packages/db/drizzle.config.ts`                                                          |
| 测试     | **文档声称 vitest（Workers pool），实测不存在**     | `docs/system-design.md:540` 声称；全仓 0 依赖、0 配置、0 用例                            |
| E2E      | **文档声称 Playwright，实测不存在**                 | `docs/system-design.md:545` 声称；lock 中 `playwright` 0 命中                            |

**依赖版本实测**（从各 `package.json` 读取，均为 `^` 范围）：

| 依赖                                                              | 声明范围  | 位置                                                    |
| ----------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| `react` / `react-dom`                                             | `^19.0.0` | storefront、admin                                       |
| `react-router` / `@react-router/dev` / `@react-router/cloudflare` | `^7.1.0`  | storefront                                              |
| `tailwindcss` / `@tailwindcss/vite`                               | `^4.0.0`  | storefront（Tailwind **v4**，走 Vite 插件而非 PostCSS） |
| `vite`                                                            | `^6.0.0`  | storefront、admin                                       |
| `hono`                                                            | `^4.6.0`  | api                                                     |
| `antd`                                                            | `^5.22.0` | admin                                                   |
| `turbo`                                                           | `^2.3.0`  | 根                                                      |
| `typescript`                                                      | `^5.6.0`  | 根 + 各 app/package                                     |
| `eslint`                                                          | `^9.0.0`  | 根                                                      |
| `prettier`                                                        | `^3.3.0`  | 根                                                      |

> 注意：eshop **不装 `@hono/zod-openapi`**、**不装 `jose`/`jsonwebtoken`**（JWT 自研）、**不装 `shadcn/ui`**（`docs/system-design.md:218` 声称用 Tailwind + shadcn/ui，但实测 lock 中 `shadcn` 零命中——文档与实测不符）。详见 §12.13。

**关键观察**：eshop 的**质量工具链是"全家桶"**——lint + format + typecheck + test 四条腿齐全，且**格式化也被纳入纪律**（DShop 缺失，见 §12.14）。

---

## 12.2 工程结构（三 app + 四包 + 两 tooling）

```
eshop/
├─ apps/
│  ├─ api/            Hono API + Cron 单一入口 + task_queue 消费
│  ├─ storefront/     React Router v7 SSR + Tailwind v4（C 端）
│  └─ admin/          Vite + React SPA（平台后台 / 商户后台，双 basename）
├─ packages/
│  ├─ auth/           JWT/刷新/TOTP/密码/手机号（8 模块）
│  ├─ db/             Drizzle schema（10 文件）+ 迁移 + client
│  ├─ services/       业务服务层（catalog 等）
│  └─ shared/         契约/枚举/错误码/RBAC/平台/运营（8 模块）
├─ tooling/
│  ├─ eslint/         @eshop/eslint-config（flat config 共享）
│  └─ tsconfig/       base.json（strict 基线）
├─ tools/             svg 生成、db 运维 SQL（非工作区包）
└─ docs/system-design.md
```

**关键观察（与 DShop 的差异）**：

1. eshop **没有 `packages/api-client`**——契约共享靠 `shared` 的类型 + Hono `hc` 的编译期类型推导（`docs/system-design.md:338`）。DShop 额外建了 `packages/api-client`（**更重，但对 PiEcho 侧 Agent 消费方更友好**，保留）。
2. eshop 把**业务编排放在 `apps/api/src/`**（`routes/*` **21 个扁平文件**、`lib/order-service.ts` 322 行、`lib/task-queue.ts`、`lib/middleware.ts`、`jobs/scheduler.ts` 187 行），`packages/*` 偏**纯函数/契约/schema**。DShop 现状把编排分散在 `packages/services` 与 `apps/api`，**层次不如 eshop 清晰**。
3. eshop **没有 `tooling/vitest`**，测试配置在各包内联。

---

## 12.3 Cloudflare 资源与绑定（三 Worker 全量）

### 12.3.1 `apps/api/wrangler.jsonc`（原文要点）

```jsonc
{
  "name": "eshop-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "eshop-db",
      "database_id": "<真实 UUID>",
      "migrations_dir": "../../packages/db/migrations",
    },
  ],
  "kv_namespaces": [{ "binding": "KV", "id": "<真实 32 位 hex>" }],
  "r2_buckets": [{ "binding": "R2", "bucket_name": "eshop-assets" }],
  "triggers": { "crons": ["* * * * *"] },
}
```

- **绑定集合**：D1 ×1、KV ×1、R2 ×1、Cron ×1。
- **无** `durable_objects`、**无** `migrations`（DO 迁移）、**无** `queues`、**无** `services`、**无** `assets`、**无** `vars`、**无** `env` 多环境段。
- `database_id` 是**真实 UUID**（非占位符）——eshop 的默认配置**开箱可部署**。
- `compatibility_date` 统一 `2026-09-01`（三个 Worker 一致）。

### 12.3.2 `apps/storefront/wrangler.json`

```jsonc
{
  "name": "eshop-storefront",
  "main": "app/worker.ts",
  "compatibility_date": "2026-09-01",
  "assets": { "directory": "./build/client", "binding": "ASSETS", "not_found_handling": "none" },
  "d1_databases": [{ "binding": "DB", "database_name": "eshop-db", "database_id": "<同一 UUID>" }],
  "kv_namespaces": [{ "binding": "KV", "id": "<同一 id>" }],
  "services": [{ "binding": "API", "service": "eshop-api" }],
}
```

- SSR Worker **直接读 D1/KV**（SSR 首屏免一跳），同时用 **Service Binding `API`** 同源反代 `/api/*`。

### 12.3.3 `apps/admin/wrangler.json`

```jsonc
{
  "name": "eshop-admin",
  "main": "worker.ts",
  "compatibility_date": "2026-09-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application",
    "html_handling": "auto-trailing-slash",
    "run_worker_first": ["/api/*", "/"],
  },
  "services": [{ "binding": "API", "service": "eshop-api" }],
}
```

- 纯静态 SPA（Workers Static Assets）+ SPA fallback + `run_worker_first` 只放行 `/api/*` 与 `/` 进 Worker。

### 12.3.4 部署单元与域名（`docs/system-design.md:514-518`）

| Worker       | 域名                                                                           | 内容                                       |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `api`        | `api.example.com/*` + `www/admin/merchant.example.com/api/*`（Route 同源转发） | Hono API + task_queue 消费 + Cron 单一入口 |
| `storefront` | `www.example.com/*`                                                            | React Router SSR + 静态资源                |
| `admin`      | `admin.example.com/*`、`merchant.example.com/*`                                | 静态资产（SPA fallback）                   |

**关键观察**：eshop 用 **Service Binding** 而非公网 fetch 做同源反代，并在代码注释里写明**踩坑原因**——`*.workers.dev` 同 zone 下保留 Host 头的公网 fetch 会被 Cloudflare 按 Host 绕回本 Worker（实测 404）。**这是 DShop 必须照抄的一条硬知识**。

---

## 12.4 运行时骨架（env / 入口 / 中间件链 / 响应体）

### 12.4.1 `apps/api/src/env.ts`——绑定驱动的最小类型

```ts
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  JWT_SECRET: string; // 本地 .dev.vars，生产 wrangler secret
  ORDER_QUEUE?: Queue; // 可选升级缝 S1：加此绑定即切 Queues
}
```

**这是升级缝纪律的类型级表达**：升级缝对应的绑定一律 `?` 可选，缺省即默认实现。

### 12.4.2 `apps/api/src/index.ts`——入口只有 20 行

```ts
const app = new Hono<{ Bindings: Env }>();
app.use(logger());
app.get("/", (c) => c.json(ok({ name: "eshop-api", version: "0.1.0" })));
app.route("/api/v1/shop", shopRoutes);
app.route("/api/v1/admin", adminRoutes);
app.route("/api/v1/merchant", merchantRoutes);
app.route("/api/v1/callbacks", callbackRoutes);

export default { fetch: app.fetch, scheduled: runScheduled } satisfies ExportedHandler<Env>;
```

**两个关键纪律**：① 命名空间挂载集中在入口，路由模块自组装；② `scheduled` 与 `fetch` 同文件导出——**Cron 只有一个入口**。

### 12.4.3 中间件链（`docs/system-design.md:345`，顺序固定）

```
requestId → accessLog → rateLimit(按路由组配置) → auth(aud) → rbac(perm) → merchantScope → zodValidator → handler
```

- `merchantScope` 是**数据行级隔离**：商户身份的所有查询自动强制注入 `merchant_id = 当前商户`，实现于 Drizzle 查询层封装（`:348`）。**不依赖前端传参**。
- 实测 `lib/middleware.ts` 导出：`requireAuth(aud)`（JWT 校验 + `aud` 不匹配一律 401）、`requirePerm(perm)`、`readToken(c)`（**双模**：`Authorization: Bearer` 或 Cookie `at`）、`ACCESS_COOKIE`/`ACCESS_COOKIE_OPTS`（HttpOnly + Secure + SameSite=Lax，2h）、`REFRESH_COOKIE`/`REFRESH_COOKIE_OPTS`（path 限 `/api/v1`，14d）。

### 12.4.4 统一响应体（`lib/response.ts`）

```ts
ok<T>(data, message='OK')  → { code: 'OK', message, data }
fail(code: ErrorCode, message) → { code, message }
httpStatusFor(code) → 200 / 400 / 401 / 403 / 404 / 409 / 429 / 500
```

**错误码集中在 `@eshop/shared`**，HTTP 状态由码表反查。**这是"单一事实源"的干净做法**。

---

## 12.5 认证与权限（`docs/system-design.md:491-508`）

| 项            | 方案                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| Access Token  | JWT **HS256（WebCrypto）**，载荷 `sub / aud(shop·admin·merchant) / role / mid(商户)`，有效期 **2h** |
| Refresh Token | 随机串，D1 存**哈希**，14d，**旋转式**（每次刷新作废旧），支持管理端强制吊销                        |
| Web 携带      | HttpOnly + Secure + SameSite=Lax Cookie，**各入口域名独立**（`admin`/`merchant` Cookie 互不可见）   |
| 小程序/APP    | `Authorization: Bearer`，**同一套签发与校验逻辑**                                                   |
| CSRF          | 同源 + `Origin` 头校验中间件                                                                        |
| 隔离          | 三个 `aud` 的 Token 在 API 层**互斥**：`shop` Token 访问 `/admin/*` 直接 401                        |

**RBAC**（`:505-508`）：权限点命名 `域:动作`（`merchant:approve`、`product:review`、`settlement:confirm`、`order:ship`）；角色权限集存 `roles.permissions`（jsonb 数组），**平台管理员可自定义新角色**；`requirePerm` 接口级拦截；前端按**同一权限集**渲染菜单与按钮（`shared` 维护，前后端一致）；后台所有写操作落 `audit_logs`。

**关键观察**：eshop 的 RBAC 是**数据驱动**（roles 表 + jsonb 权限集），DShop 的 RBAC 是**代码内置**（`packages/shared/src/rbac.ts`）。前者更灵活，后者更简单——DShop 保持代码内置，但需**明确记录这是有意取舍**。

---

## 12.6 数据模型（`docs/system-design.md:368-431`）

**存储约定**：D1（SQLite）；主键统一 **ULID 字符串**；金额一律**整数（分）**；时间 **ISO-8601 字符串**；快照字段（下单时的商品标题/图/规格/单价）**一律落到 `order_items`，不回查商品表**。

**表清单（32 张，按域分组，`:393-425`）**：

| 域   | 表                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------- |
| 会员 | `users`、`user_addresses`                                                                       |
| 账号 | `admin_users`、`roles`、`merchant_members`                                                      |
| 商户 | `merchants`、`stores`                                                                           |
| 商品 | `categories`、`products`、`product_skus`、`product_images`                                      |
| 交易 | `cart_items`、`orders`、`sub_orders`、`order_items`、`order_status_logs`、`payments`、`refunds` |
| 售后 | `aftersales`                                                                                    |
| 营销 | `coupon_templates`、`user_coupons`、`freight_templates`                                         |
| 内容 | `reviews`、`content_blocks`                                                                     |
| 结算 | `settlements`、`settlement_items`                                                               |
| 支撑 | `task_queue`、`audit_logs`、`settings`、`refresh_tokens`、`idempotency_keys`                    |

**三条关键设计决策（`:429-431`）**：

1. **拆单**：一次结算含多商户 → 1 主单（用户视角，一次支付）+ N 子单（商户视角，独立发货/售后/结算）；优惠券、运费在主单层算后**按比例分摊**到子单。
2. **库存不超卖**：D1 **无交互式事务** → **单语句原子更新**：
   `UPDATE product_skus SET stock = stock - ?, locked_stock = locked_stock + ? WHERE id = ? AND stock >= ?`，影响行数为 0 即库存不足；支付成功把 `locked_stock` 转实扣，关单则释放。
3. **幂等**：下单用 `Idempotency-Key`（结果存 `idempotency_keys` 表）；支付回调用渠道流水号 `channel_trade_no` **唯一约束**兜底。

**关键观察**：eshop 的**业务域划分是 10 个域 / 32 表**，DShop 是 **41 表**（含 Agent 客服域）。DShop 多出的部分正是与 PiEcho 的集成面（政策、Agent 令牌、审计），**属于合理扩张**。

---

## 12.7 API 命名空间与契约（`docs/system-design.md:325-340`）

**四个命名空间**：`/api/v1/shop`、`/api/v1/admin`、`/api/v1/merchant`、`/api/v1/callbacks`（含微信支付 v3 验签）。

- Web 端通过 **`api-client`（Hono `hc`）获得编译期类型化调用**；小程序/APP 场景用 `@hono/zod-openapi` 导出 OpenAPI 文档作契约。
- 统一响应体 `{ code, message, data }`；错误码集中在 `shared`；分页统一 `page/pageSize/total`。
- 鉴权双模（Cookie / Bearer）。

**关键观察**：eshop 的命名空间划分是**按消费方**（C 端 / 平台后台 / 商户后台 / 支付回调）。DShop 有**五个**（`shop`/`admin`/`merchant`/`callbacks`/`agent`），多出的 `agent` 是给 PiEcho 的服务令牌只读面。**结构同构，值得对齐的是"每个命名空间后端必须真实存在"**——eshop 四个都有实现，DShop 现状只有 `agent` + `admin` 有（见 §12.14 P0-3）。

---

## 12.8 异步与定时（`docs/system-design.md:350-366` + `lib/task-queue.ts`）

### 12.8.1 TaskQueue 接口（业务层唯一依赖点）

```ts
export type TaskType =
  "notify.payment_success" | "notify.shipped" | "notify.aftersale" | "stats.recalculate";

export interface TaskQueue {
  enqueue(type: TaskType, payload: Record<string, unknown>): Promise<void>;
}

class D1TaskQueue implements TaskQueue {
  /* INSERT INTO task_queue ... */
}
class QueuesTaskQueue implements TaskQueue {
  /* queue.send({ type, payload }) */
}

export function getTaskQueue(env: Env): TaskQueue {
  if ("ORDER_QUEUE" in env && env.ORDER_QUEUE)
    return new QueuesTaskQueue(env.ORDER_QUEUE as unknown as Queue);
  return new D1TaskQueue(env.DB);
}
```

**三个值得照抄的实现细节**：

1. **`enqueue` 必须 `await`**——代码注释明确写了原因：_"Workers 中未 await 的 D1 写入可能在响应返回后被取消（任务静默丢失）"_。
2. **绑定检测用 `'ORDER_QUEUE' in env && env.ORDER_QUEUE`**（而非仅真值判断），兼容 `undefined`/缺字段两种缺省形态。
3. **默认实现语义与升级目标对齐**——`task_queue` 表含 `attempts`/`max_attempts`/`next_run_at`，**重试/退避/死信/幂等按 Queues 能力设计**，切换后**不补逻辑、不迁数据**（`:576`）。

### 12.8.2 `task_queue` 表与消费规则（`:357`）

字段：`id`、`type`、`payload`、`status(pending/processing/done/failed)`、`attempts`、`max_attempts`、`next_run_at`、`created_at`。

消费规则：**单次 Cron 最多处理 N=50 条**；`processing` 超时未确认**自动重回 `pending`（幂等）**；连续失败 `attempts >= max_attempts` 置 `failed` **进死信，后台可见可重放**。

### 12.8.3 Cron 单一入口（`:526`、`jobs/scheduler.ts` 187 行）

**每 1 分钟一个 Cron，内部分发五类作业**：

| 任务                               | 触发        | 说明                                             |
| ---------------------------------- | ----------- | ------------------------------------------------ |
| 通知发送（支付成功/发货/售后进度） | TaskQueue   | 失败按 `next_run_at` 退避重试                    |
| 超时未支付关单                     | Cron 每分钟 | `task_queue` 到期消费（生产者按 `pay_deadline` 带 `delaySeconds`）+ handler 二次校验 `pay_deadline`（未到期则延后） → 关单 + 释放锁定库存 |
| 自动确认收货                       | Cron 每小时 | 发货后 N 天自动完成（N 可配置）                  |
| 结算单生成                         | Cron 每日   | 按 T+N 汇总 vendor 子单                          |
| 优惠券过期                         | Cron 每日   | 批量置失效                                       |
| **task_queue 消费**                | Cron 每分钟 | 按类型分发到 handler                             |

**关键观察**：**"单一 Cron 入口 + 内部分发"是 eshop 的核心设计**——免费层只有 **5 个 Cron 触发器/账户**（`:579`），单一入口把额度消耗压到最小，且分发逻辑在应用层，不受平台限制。

---

## 12.9 ★ 升级缝 S1–S9 与三条硬规则（`docs/system-design.md:547-579`）

### 12.9.1 设计纪律（贯穿全文的约定，`:551`）

> Cloudflare 付费组件**一律不直接 import**，全部藏在自研接口后面（`wrangler.jsonc` 绑定 + 适配器切换）。业务代码只面向接口编程，**升级 = 改绑定 + 切适配器，一次 PR 内完成，不碰业务逻辑**。下表是**能力选项清单，不是升级必做项**——每条缝按量级与需求独立决策，**任何一条都可以永远停留在默认实现**。

### 12.9.2 配置模型：每缝一个独立开关——没有套餐，没有全局开关（`:553-558`）

- **不存在「免费配置 / 付费配置」两套预设文件**，也没有 `PAID=true` 之类的全局模式位。每个环境的唯一差异，就是**该环境绑定集合**。
- **一条缝 = 一个绑定 = 一个开关**：绑定缺省 → 默认实现（零配置即可用）；加绑定 → **仅该缝**自动切升级实现；**删绑定 → 即刻回滚**。缝与缝**零耦合**，爆炸半径限制在单个适配器。
- **可按环境任意组合灰度**：切换粒度 = **单缝 × 单环境**。
- **两个例外**（同样不构成强制）：① Workers 付费计划本身是**账户级**——升计划不强制启用任何组件；② S6/S8 属**平台侧 Dashboard 配置**，不进应用绑定。

### 12.9.3 缝清单（`:560-571`）

| #       | 升级缝       | 默认实现（零配置）                         | 按需升级为                         | 开关方式                                 | 备注                                                     |
| ------- | ------------ | ------------------------------------------ | ---------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| **S1**  | 异步任务     | D1 `task_queue` 表 + Cron 单一入口轮询     | Cloudflare Queues                  | 加/删 `ORDER_QUEUE` 绑定，运行时自动检测 | handler 与业务代码**零改动**；删除绑定即回滚             |
| **S2**  | 数据库读扩展 | services 读路径单库直连（+Cache API 缓存） | D1 只读副本（Sessions API）        | services 层读连接加 `withSession` 配置   | 读写路径已分离，属配置级变更                             |
| **S3**  | 密码哈希     | **PBKDF2（WebCrypto，CPU 档位无关）**      | argon2id                           | `packages/auth` 哈希函数**单点替换**     | 哈希带**算法前缀**（`pbkdf2$...`），登录**惰性升级**存量 |
| **S3b** | CPU 密集任务 | 拆分为批量小步（Cron 分批处理）            | Workers 付费 CPU 档位（30s+）      | **账户级计划，无应用配置**               | 升计划不强制启用其他缝                                   |
| **S4**  | 实时推送     | **前端轮询**（Cache API 防抖）             | Durable Objects WebSocket / SSE    | 前端 `OrderStatusSource` 抽象后换实现    | 接入点**独立于交易主链路**，可灰度                       |
| **S5**  | 搜索         | D1 `LIKE` + 简单分词查询                   | Cloudflare Vectorize / 外置搜索    | services 层商品读接口换查询实现          | 接口不变，纯内部替换                                     |
| **S6**  | 图片加工     | 上传时生成固定尺寸（Workers 一次处理）     | Image Resizing / Cloudflare Images | **Dashboard 平台配置**                   | URL 规范已预留变体参数位                                 |
| **S7**  | 缓存         | **Cache API 边缘缓存**                     | 叠加热点 KV/缓存层                 | 按需叠加，无切换                         | 任何阶段都无需变更                                       |
| **S8**  | 限流         | **应用层自研**（Hono 中间件 + 计数）       | WAF 自定义限流规则                 | **Dashboard 平台配置**                   | 应用层实现**保留为兜底**                                 |
| **S9**  | 出海/多区    | 单区域 D1                                  | 多区域副本 + 地理路由              | 同 S2 + Cloudflare 地理路由              | 远期选项                                                 |

> **DShop 命名差异（有意）**：上表照抄 eshop 原文，其绑定名是 `ORDER_QUEUE`。
> DShop 锁定为 **`TASK_QUEUE`**——理由：该表不只服务订单（还有售后、通知、结算等），
> `ORDER_QUEUE` 会误导。**这是有意的改名，不是抄错**。对应关系：
> `ORDER_QUEUE`(eshop) → `TASK_QUEUE`(DShop)。

### 12.9.4 落地机制（三条硬规则，`:573-577`）

1. **绑定驱动实现选择**：适配器按 `env` 中是否存在对应绑定自动选择（如检测到 `env.ORDER_QUEUE` 即用 Queues 实现）——免费 dev 环境与付费生产**同一份代码**，且**绑定在哪个环境加，哪个环境才升级**，天然支持逐缝逐环境灰度。
2. **默认实现语义与升级目标对齐**：默认实现的重试/退避/死信/幂等按升级目标能力对齐设计，切换**不补逻辑、不迁数据**——因此「暂不升级」**不欠任何技术债**。
3. **付费组件进架构走评审**：新增任何 Cloudflare 付费依赖前，先回答「**能否包在既有升级缝后面**」；不能则视为**重大架构变更**。

---

## 12.10 免费层边界与环境策略（`docs/system-design.md:531-534, 579`）

### 12.10.1 免费层额度（eshop 原文 `:579`）

> Workers **10 万请求/天、10ms CPU/请求**；D1 **500 万行读/天、10 万行写/天、5GB**；KV **1000 写/天**；R2 **10GB**；Cron 触发器 **5 个/账户**；Queues/Workflows/DO/Images **不可用**。开发期注意：本地 `wrangler dev` 与 preview 环境请勿压测。

> ⚠️ **本审计的更正**：eshop 该行中「DO 不可用」**已过时**。Cloudflare 现行政策：**Durable Objects 在 Workers Free 与 Paid 计划均可用；Free 计划仅支持 SQLite 存储后端**（配额 10 万请求/天、13,000 GB-s/天）。DShop 的 `new_sqlite_classes` 迁移正是为此。
> **但这不改变纪律结论**：DShop 现状把 DO 作为 S8 默认实现，**反向了 eshop 的 S4+S8**（eshop 默认前端轮询 / 应用层自研，DO 与 WAF 是升级项）。纪律的正确性不依赖"DO 是否免费"，而依赖"**付费/平台组件是否被藏在自研接口后面**"。

### 12.10.2 环境策略（`:531-534`）

- `dev/preview`：**Cloudflare 免费层**（本地 `wrangler dev` + PR 预览环境，隔离 D1/KV）。
- `staging`：main 分支自动部署；`production`：打 tag 部署——**运行于 Workers Paid 账户**。
- **付费组件按需启用**：生产可以**长期只跑 task_queue 默认实现**，量级到了再单独加 Queues 绑定。
- **业务代码不感知环境差异**，统一走 `TaskQueue` 等接口，由 wrangler 绑定差异切换实现。
- D1 迁移通过 `wrangler d1 migrations apply` **随部署流水线执行**，先 staging 验证再 production。

---

## 12.11 CI/CD 与质量闸门（`docs/system-design.md:537-545` vs `.github/workflows/ci.yml`）

**eshop 文档声称的三级流水线**（`docs/system-design.md:537-545`）：

```
PR:    install → lint → typecheck → vitest（Workers pool） → build → 部署 preview 环境
main:  同上 → 部署 staging → 冒烟（E2E 关键链路）
tag:   同上 → wrangler d1 migrations apply → 部署 production
```

**实测 `.github/workflows/ci.yml`（36 行，全文）**：`on: push[main] + pull_request`；单个 job `ci`（`ubuntu-latest`）；步骤依次为
`actions/checkout@v4` → `pnpm/action-setup@v4`（`version: 12.4.1`）→ `actions/setup-node@v4`（`node-version: 22`、`cache: pnpm`）→ `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`。

**逐条对照**：

| 文档声称                          | 实测                                                                                        | 结论 |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ---- |
| PR 阶段跑 `vitest`                | CI 有 `pnpm test`，但 `turbo run test` 仅命中 `packages/auth` 一个 `totp.test.mts`（见 §12.16） | **名义成立、实质近乎为空** |
| PR 部署 preview 环境              | CI 中**无任何 `wrangler` 调用**                                                              | **不存在** |
| main 部署 staging + E2E 冒烟      | CI 中**无 deploy、无 Playwright、无 staging**                                                | **不存在** |
| tag 跑 `wrangler d1 migrations apply` + 部署 production | CI 中**无 tag 触发、无迁移步骤、无 production**                                | **不存在** |
| 「E2E 作为每阶段验收底线」         | 全仓 `playwright` 0 命中                                                                     | **不存在** |
| 根 `package.json` 有 `deploy` script | ✅ 属实（`"deploy": "turbo run deploy"`），且每个 app 自带 `deploy` script                  | 成立 |

> **纪律层面的结论（与 DShop 的对比才是重点）**：eshop 的 CI 只有「**装依赖 + 三个静态检查 + 构建**」，**不含任何部署自动化**；文档中的「PR→preview / main→staging / tag→production」三级流水线是**设计意图而非实现**。这与 eshop 的一贯形态一致：**设计文档把「应有的工程纪律」写得很足，但落地程度参差**（另见 §12.16 测试基建、§12.17 E 系列）。
>
> DShop 的对照：`.github/workflows/ci.yml` 同样只做 `check/lint/build` + 四环境 `wrangler deploy --dry-run`，**CI 未接入真实部署**。但 DShop 的**部署本身已人工真实执行并端到端验证**（见 §12.16 第 3 条：真实 D1 库 + `wrangler deploy` + 线上 Cron 关单链路），这一点**优于** eshop 的「文档写了三级流水线但 CI 里一行 `wrangler` 都没有」。DShop 的 CI 与 eshop 在「自动化程度」上实质持平，但 DShop 的**已验证范围**更实——**且文档如实标注了「CI 未接入真实部署」**，这正是 §12.17 的纪律。

---

## 12.12 工具链与配置纪律

| 项                 | eshop                                                                                 | 证据                                  |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------- |
| ESLint flat config | 根 `eslint.config.js` + `tooling/eslint`（`@eshop/eslint-config` 共享）               | 两文件                                |
| TS 基线            | `tooling/tsconfig/base.json`（strict）                                                | 共享继承                              |
| 格式化             | `.prettierrc.json` + `prettier --write .`                                             | 根 scripts                            |
| 环境变量样例       | `apps/api/.dev.vars.example`（`JWT_SECRET=dev-insecure-secret-change-in-production`） | 实测存在；`.dev.vars` 被 `.gitignore` |
| 依赖构建白名单     | `pnpm-workspace.yaml` 的 `onlyBuiltDependencies: [esbuild, workerd]`                  | 显式声明原生依赖构建                  |
| 工作区             | `apps/*` + `packages/*` + `tooling/*`                                                 | pnpm-workspace                        |
| 无                 | `worker-configuration.d.ts`、独立 vitest 配置文件                                     | 实测缺失                              |

---

## 12.13 风险登记（`docs/system-design.md:616-626`）

| #   | 风险                                   | 等级 | 缓解                                                        |
| --- | -------------------------------------- | ---- | ----------------------------------------------------------- |
| R1  | 大陆访问 Cloudflare 延迟/稳定性        | 高   | 自定义域 + 实测；备案；保留迁移路径（§13.3）                |
| R2  | D1 写入吞吐上限（单库、无交互事务）    | 中   | 原子 SQL + task_queue 削峰；读以 Cache API 为主；压测设红线 |
| R3  | 平台「二清」合规                       | 高   | 一期自营直收规避；M5 前落地分账方案                         |
| R4  | D1 容量（单库 10GB）与供应商锁定       | 低   | 冷数据归档 R2；Drizzle 保持可迁移                           |
| R5  | 微信支付证书/回调在 Workers 的兼容细节 | 低   | M2 初做支付打样（沙箱）最先验证                             |
| R6  | 多商户拆单后优惠/运费分摊复杂度        | 中   | 分摊算法集中一处，单测覆盖边界                              |
| R7  | 免费层额度耗尽影响当日开发             | 低   | 生产在付费层不受此限；preview 不压测                        |

---

## 12.14 ★ DShop 相对 eshop 的偏离清单（审计结论）

> 判定基准：**「付费/平台组件一律不直接 import，藏在自研接口后面；绑定缺省即默认实现；删绑定即回滚」**。

### P0（违反纪律核心，必须修）

| #        | 偏离（审计时）          | 现状证据                                                                                                                                                | **当前状态**                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-1** | **S1 异步任务缝不存在** | `packages/services` grep `TaskQueue` = 0；`ORDER_QUEUE` 全仓仅 2 处**注释**；`env.ts` 无该字段；`apps/api/src/jobs/task-queue.ts` 是裸 SQL 函数而非接口 | ✅ **已闭环**：`TaskQueue` 接口 + `D1TaskQueue`(默认) + `QueuesTaskQueue`(升级) + `getTaskQueue(env)`；**真实生产者调用点**在 `routes/shop/orders.ts` 下单成功后 `await enqueue(ORDER_TIMEOUT_CANCEL, payload, { delaySeconds })`；**消费者**在 `jobs/task-queue.ts` 的 `createTaskHandlers(db)`（唯一分发表）；**Queues 出口** `jobs/index.ts` 的 `queue()` 与 Cron **共用同一分发表**。31 项闭环测试（`tests/upgrade-seam-callsites.test.ts`，含 P1-A 同毫秒二次关单、P1-B 期限兜底、P2 退避/自愈） |
| **P0-2** | **S5 搜索缝两端零代码** | 全仓 `LIKE` 仅 1 处**注释**；`repositories/products.ts` 无列表/搜索函数                                                                                 | ⚠️ **部分闭环（如实降级）**：适配器已就绪（`product-search.ts` 的 `D1LikeProductSearch` + 绑定驱动 `getProductSearch`），但**本期无搜索端点**，故**无调用点**。**刻意不为凑缝而新造端点**——见 §12.14.1                                                                                                                                                                                         |
| **P0-3** | **五组命名空间缺三组**  | 后端**只有** `/api/v1/agent` + `/api/v1/admin`；`/shop`、`/merchant`、`/callbacks` **零实现**                                                           | ✅ **已闭环**：`/api/v1/shop`、`/api/v1/merchant`、`/api/v1/callbacks` 三组已实现并挂载（`src/index.ts`）；含错误码分层测试与真实入口测试                                                                                                                                                                                                                                                      |

### P1（纪律缺口，应修）

| #        | 偏离（审计时）          | 现状证据                                                         | **当前状态**                                                                                                                                                                                       |
| -------- | ----------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1-1** | S2/S11 读扩展缝无绑定位 | `env.ts` 只有 `DB`；`withSession`/`AGENT_DB` grep = 0            | ✅ **已闭环**：`env.ts` 增 `READ_DB?: D1Database`；`getReadDb`/`getReadDrizzle` 绑定驱动（无绑定时**返回 `env.DB` 本身**，默认零变化）；**已接入** `routes/shop/catalog.ts` 的三条读路径           |
| **P1-2** | S7 缓存升级层无绑定位   | `lib/cache.ts` 的 Cache API 默认实现质量高，但**无 KV 叠加入口** | ⚠️ **适配器已就绪，调用点待接**：`cache-port.ts` 的 `CachePort` + `NoopCachePort`(默认) + `getCachePort`；因 Cache API 已覆盖边缘缓存，S7 的升级形态是**叠加**而非切换，**本期未叠加**（如实标注） |
| **P1-3** | S6 图片缝缺失           | 无 `r2_buckets` 绑定、无 `presign`；前端如实声明"不提供上传入口" | ⚠️ **适配器已就绪，调用点待接**：`media.ts` 的 `MediaPort` + `getMediaPort`；因**本期无上传端点**，无调用点。**不为凑缝而新造端点**                                                                |

### P2（工程纪律缺口，宜修）

| #        | 偏离                                   | 现状证据                                                                                                                         |
| -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **P2-1** | S3 密码缝无分派表                      | 算法前缀 ✅ + 常量时间 ✅，但 `parsePasswordHash` **硬拒**其他算法，**无分派/惰性升级钩子**                                      |
| **P2-2** | 无 `env` 多环境段                      | `wrangler.jsonc` 无 `env`——无法做到 eshop 的"**单缝 × 单环境**"灰度                                                              |
| **P2-3** | DO 被入口**无条件 import + re-export** | `apps/api/src/index.ts:37,49`；技术必需，但默认 bundle 含 DO 代码（**已通过"不绑绑定"把运行时影响降到零**）                      |
| **P2-4** | 工具链缺项                             | **无 Prettier**（`docs/03:34` 声称有）；`npm run deploy` 不存在（`docs/09:114` 声称有）；`.dev.vars.example` 缺失；CI 无部署步骤 |

### P3（非偏离，诚实标注 / 已达标）

| 项                          | 判定                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storefront SSR 未落地       | **非偏离**——`apps/storefront/README.md` 如实标注四项损失。eshop 是 SSR，DShop 是 SPA，属**有意识的降级**，已记录                                                                                        |
| S8 限流缝                   | ✅ **唯一完全达标**：`RateLimitStore` 接口 + `InMemory`/`DurableObject` 双实现 + `createRateLimitStore(namespace)` 绑定驱动 + **降级仍限流** + 告警 + `X-RateLimit-Store`/`X-RateLimit-Degraded` 真话头 |
| S4 实时推送                 | ✅ `OrderStatusSource` 抽象 + `PollingOrderStatusSource` + 工厂                                                                                                                                         |
| 错误码分层                  | ✅ Agent 组整数码 / 后台组字符串码，`isAgentPath()` 分流 + 测试固化 + 负向控制                                                                                                                          |
| 数据模型                    | ✅ 41 表（eshop 32 表 + Agent 客服域），迁移存在                                                                                                                                                        |
| tsconfig 纪律               | ✅ `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`，与 eshop 对齐                                                                                                                        |
| Agent 只读四重保证          | ✅ 超 eshop 范围                                                                                                                                                                                        |
| `scripts/check.ts` 自动发现 | ✅ 优于 eshop 的固定 turbo 编排（新增工作区自动纳入闸门）                                                                                                                                               |

---

## 12.15 本轮收敛动作（对齐 eshop 纪律）

> 本节记录为收敛上述偏离而执行的动作；结果以闸门实测为准（§12.16）。

| 偏离 | 收敛动作                                                                                                                                         | 验收方式                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| P0-1 | 新增 `TaskQueue` 接口 + `D1TaskQueue`（默认）+ `QueuesTaskQueue`（升级）+ `getTaskQueue(env)` 绑定驱动；`env.ts` 加 `TASK_QUEUE?: Queue`（可选） | 单测：缺绑定走 D1、加绑定走 Queues、删绑定回滚 |
| P0-2 | 新增搜索缝：`ProductSearchPort` 接口 + D1 `LIKE` 默认实现 + Vectorize 升级实现 + 绑定驱动选择                                                    | 单测：两实现同接口、绑定切换                   |
| P0-3 | 补齐 `/api/v1/shop`、`/api/v1/merchant`、`/api/v1/callbacks` 三个命名空间后端（对齐 eshop 的四命名空间）                                         | 单测：路由可达 + 错误码分层正确                |
| P1-1 | 读写分离缝：`createDb(env)` 单点 + `READ_DB?` 可选绑定位                                                                                         | 单测：缺绑定回退主库                           |
| P1-2 | 缓存叠加缝：`CachePort` + Cache API 默认 + KV 叠加（`CACHE_KV?` 可选绑定）                                                                       | 单测：绑定切换语义                             |
| P1-3 | S6 图片缝：`r2_buckets` 绑定 + 预签名/直传接口位                                                                                                 | dry-run 通过 + 单测                            |
| P2-1 | S3 分派表：`parsePasswordHash` → 算法分派 + 惰性升级钩子                                                                                         | 单测：旧哈希登录后升级                         |
| P2-2 | `wrangler.jsonc` 增 `env` 段（preview/staging/production），演示"单缝 × 单环境"                                                                  | dry-run 通过                                   |
| P2-4 | 补 Prettier 配置 + `deploy` script + `.dev.vars.example` + CI 部署步骤位                                                                         | `npm run format:check`、脚本存在性             |

**收敛铁律（照抄 eshop 硬规则）**：

1. **绑定驱动实现选择**——`'X' in env && env.X`。
2. **默认实现语义与升级目标对齐**——重试/退避/死信/幂等按升级目标设计，切换不补逻辑。
3. **付费组件进架构走评审**——新增付费依赖前先问"能否包在既有缝后面"。

### 12.15.1 ⚠️ 诚实边界：缝的「就绪」不等于「已接」

本轮把 6 条缝的**适配器与绑定驱动**全部做完，但**只有 S1/S2/S8 有真实业务调用点**。
其余三条的现状必须如实区分，否则「缝已存在」会被误读为「缝已生效」：

| 缝              | 适配器 | 绑定驱动 | **真实调用点**                                                                                   | 判定                         |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------ | ---------------------------- |
| **S1** 异步任务 | ✅     | ✅       | ✅ `routes/shop/orders.ts` 下单后入队；`jobs/task-queue.ts` 消费；`jobs/index.ts` `queue()` 出口 | **已生效**                   |
| **S2** 读副本   | ✅     | ✅       | ✅ `routes/shop/catalog.ts` 三条读路径走 `getReadDb`                                             | **已生效**（默认零变化）     |
| **S8** 限流     | ✅     | ✅       | ✅ 中间件链                                                                                      | **已生效**（且经对抗性复核） |
| **S5** 搜索     | ✅     | ✅       | ❌ **无搜索端点**                                                                                | 适配器就绪，**无调用点**     |
| **S6** 媒体     | ✅     | ✅       | ❌ **无上传端点**                                                                                | 适配器就绪，**无调用点**     |
| **S7** 缓存叠加 | ✅     | ✅       | ❌ **未叠加**（Cache API 已覆盖边缘缓存）                                                        | 适配器就绪，**无调用点**     |

**为什么不为 S5/S6 新造端点**：为了「让缝看起来生效」而新增一个无人调用的搜索/上传接口，
会增加**未经需求验证**的公开面（鉴权、限流、错误码、审计都要配套），
属于**纸面覆盖**——正是 eshop 文档被诟病的问题（§12.17.2 的 E15–E21）。
**诚实的「适配器已就绪、暂无调用点」优于虚假的「缝已全部生效」。**

**升级到有调用点的成本**：S5/S6 各自只需在**新增该业务端点时**用 `getProductSearch(env)` / `getMediaPort(env)`
取端口即可——这正是缝的设计意图（业务代码面向接口，加绑定不改逻辑）。

---

## 12.16 诚实边界（未验证 / 已知缺口）

1. **本审计未阅读 eshop 业务代码实现细节**（用户明确要求）——`docs/system-design.md` 中"声称"与"实测"已分列，凡实测项均在 §12.1–§12.12 标注证据。
2. **eshop 的 vitest/Playwright 不是「配置未实测」，而是「根本不存在」**（本轮已实测）：`pnpm-lock.yaml` 中 `vitest` / `playwright` / `vitest-pool-workers` **均 0 命中**；全仓唯一测试是 `packages/auth/test/totp.test.mts`（用 `node --experimental-strip-types` 跑）；CI 的 `pnpm test` → `turbo run test` 只命中该一个文件。`docs/system-design.md:222/540/545` 的声称与 `README.md:105` 的自述（「当前仅 `packages/auth` 有 TOTP 单测」）**直接矛盾**——见 E48/E49。DShop 未采用 `@cloudflare/vitest-pool-workers`，而是用 `node:sqlite` 真库替身。
3. **DShop 真实部署已完成并端到端验证（本轮闭环）**——四个真实 D1 库已创建（`dshop-dev` `43b05e4f…`、`dshop-preview` `f2cec642…`、`dshop-db-staging` `6e67c6bb…`、`dshop-db` `ef99acfb…`），`database_id` 占位符已替换为真实 UUID；迁移在真实库上应用（41 张表）；`wrangler deploy` 真实上传成功 → **`https://dshop-api.eeshop.workers.dev`**（Cron `* * * * *` 已注册；绑定只有 `env.DB` + 两个环境变量，**零 DO/Queues/缝绑定**——「默认零绑定」纪律的线上实证）。线上验证：`/health` 200；商品列表/详情返回真实 D1 数据（含 7 个属性组）；不存在资源返回域错误码；Agent 路径无 token 返回整数码 `40101`；**真实 Cron 关单链路已验证**——注入 `pay_deadline` 已过的订单，31 秒内被 Cron 置 `CANCELLED`；注入 `pay_deadline` 在未来的订单，**未被关**且任务被延后到 `run_at = pay_deadline`（`attempts` 仍 0）；注入 `pay_deadline = NULL` 的订单，走 `createdAtMs + 15min` 兜底延后、同样未被关。**仍未验证**：`--env preview/staging/production` 未真实部署（仅 dry-run）；真实 Queues 的 `max_retries`/DLQ 行为未实测。
4. **eshop「DO 不可用」已过时**——见 §12.10.1 更正；但纪律结论不受影响。
5. **DShop 与 eshop 的关键取舍（有意保留，非遗漏）**：
   - DShop 用 **npm workspaces**（eshop 用 pnpm + turbo）——按用户决定保留 npm。
   - DShop 有 **`packages/api-client`**（eshop 无）——为 PiEcho 侧消费方提供编译期契约。
   - DShop 的 **RBAC 代码内置**（eshop 数据驱动 roles 表）。
   - DShop 的 **storefront 是 SPA**（eshop 是 SSR），已如实记录损失。
6. **仍未闭环的两项（如实登记）**：① **`--env preview/staging/production` 未真实部署**——顶层环境已真实上线（见第 3 条），但三个具名环境只做过 `--dry-run`（`database_id` 已是真实 UUID，具备真实部署条件，只是尚未执行）；② **Queues 路径的 `message.retry({ delaySeconds })` 会消耗一次投递尝试**——延后是**正常路径**而非错误路径。**配置侧已钉**（P1-C）：`apps/api/wrangler.jsonc` 的四环境 `queues` 片段现已显式声明 `max_retries: 10` + `dead_letter_queue`，**dry-run 已验证配置可编译**；但仍**未在真实 Cloudflare Queues 上验证**投递额度与 DLQ 的实际行为（延后次数上限、DLQ 落库形态、重放路径均未实测）。

---

## 12.17 eshop 自身的不一致清单（本轮彻底复核新增）

> 本节是「彻底版」审计的增量产出。审计 eshop 时**不预设它是完美参照物**——事实上它的文档、配置、代码之间存在 **51 处**不一致（E1–E51）。逐条列出，供引用时避免照抄错误结论。

### 12.17.1 文档内部自相矛盾

| #   | 不一致                               | 证据                                                                                                                                                                                                                                                   |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | **头部版本号未同步（三方不一致）**   | `system-design.md:3` 写 `评审稿 v0.4`，`:7` 已有 `v0.5 变更` 条目，`:638` 的澄清仍标注 `(v0.4)`；而 `README.md:4` 对外称设计文档是「v0.5」——**同一仓库三处对同一份文档的版本描述互不相同** |
| E2  | **`§2.3 A5` 悬空引用**               | `:593` 与 `:634` 引用「§2.3 A5 资金方案」，但 §2.3 关键假设表只有 **A1–A4**（`:60-63`），**A5 不存在**                                                                                                                                                 |
| E3  | **免费层「不可用」清单过宽**         | `:579` 称 `Queues/Workflows/DO/Images 不可用（即上表所有「付费后」列）`；但 S1–S9 的升级目标还含 D1 只读副本(S2)、Workers CPU 档位(S3b)、Vectorize(S5)、KV 叠加(S7)、WAF 规则(S8)、多区域副本(S9)——既不在那四项之列，也并非都「不可用」                |
| E4  | **「DO 不可用」与 S4 冲突**          | `:579` 说 DO 免费层不可用，`:566` 的 S4 又把 DO/SSE 列为升级目标。按 `:549`「免费层缺 Queues/DO 等，全部有默认替身」的设计意图这是**预期行为**，但措辞读起来像矛盾。**另注**：Cloudflare 现已在 Free 计划提供 DO（仅 SQLite 后端），该行本身**已过时** |
| E5  | **S6 默认实现与免费层 CPU 限额张力** | `:568` S6 默认「上传时生成固定尺寸（Workers 一次处理）」，但 `:579` 免费层限 **10ms CPU/请求**；图片处理在 10ms 内完成缺乏论证，也无兜底                                                                                                               |
| E6  | **monorepo 树形结构错误**            | `:245` 与 `:246` 重复出现 `src/jobs/`（「Queue 消费者 & Cron handlers」与「TaskQueue handler 注册表 & Cron 单一入口」）；`:256` 的 `services/` 与 `:259` 的 `api-client/` 同为末项且都用 `└─`                                                          |
| E7  | **D1 环境实例数不一致**              | `:522` 写「每环境独立实例：preview/staging/production」（3 个，无 dev）；`:533` 写 `dev/preview` 合并 + staging + production；`:607` 写「三环境部署」。**dev 是否有独立 D1 未定义**                                                                    |
| E8  | **D1 容量数字未分层说明**            | `:579` 免费层 D1 **5GB** vs `:623` R4 生产 D1 单库 **10GB**，属分层差异但未显式说明                                                                                                                                                                    |
| E9  | **`store_stocks` 表只出现在 §2.4**   | `:94` 提到门店级库存 `store_stocks`（二期按需启用），但 §9.2 的 32 张表中**没有该表**；`:603` 又声称「表结构一期全部建好」                                                                                                                             |
| E10 | **`§12.1` 未列 DO 资源**             | S4 升级目标是 DO（`:566`），§5 备选列「DO WebSocket（生产可选）」（`:230`），但 §12.1 的 CF 资源表（`:520-527`）**无 DO 条目**                                                                                                                         |
| E11 | **Workflows 孤立提及**               | `:579` 把 Workflows 列入免费层不可用，但 S1–S9 **无任何 Workflows 缝**，正文也从未纳入设计                                                                                                                                                             |
| E12 | **R4 等级列格式异常**                | `:623` 等级写「低（当前量级）」，与 R1–R7 其余行的纯等级值格式不一致                                                                                                                                                                                   |
| E13 | **`85–90%` 与 `80%` 口径混用**       | `:80` 称两模式领域重合 **85–90%**，`:148` 称后台两入口界面复用 **80%**——两个百分比口径不同（领域 vs 界面）却未区分                                                                                                                                     |
| E14 | **§2.2 非目标 vs §5/§7.3 端规划**    | `:55` 把小程序/APP 列为「本期不做」，`:231-232` §5 选型表却列出 Taro/Expo                                                                                                                                                                              |

### 12.17.2 文档声称 vs 实测（代码/配置）

| #   | 文档声称                                                                | 实测                                                                                                                    | 位置                                     |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| E15 | C 端 UI = `Tailwind CSS + shadcn/ui`                                    | **shadcn/ui 未安装**（lock 零命中）                                                                                     | 文档 `:218`                              |
| E16 | `packages/api-client/`（Hono `hc` 客户端）                              | **该包不存在**（全仓仅文档提及）                                                                                        | 文档 `:259`                              |
| E17 | 用 `@hono/zod-openapi` 导出 OpenAPI                                     | **未安装**（lock 零命中）                                                                                               | 文档 `:338`                              |
| E18 | api 路由分 `src/routes/{shop,merchant,admin,callbacks}/` **四个子目录** | 实测是 `src/routes/` 下的 **21 个扁平文件**（`shop-*.ts`、`merchant-*.ts`、`admin-*.ts`、`callbacks.ts`），**无子目录** | 文档 `:241-244`                          |
| E19 | storefront 路由在 `storefront/src/routes/`                              | 实测在 `apps/storefront/app/routes/`（React Router v7 框架模式约定）                                                    | 文档 `:249`                              |
| E20 | R2 自定义域 `img.example.com`                                           | 三份 wrangler **均无 routes / custom domain**                                                                           | 文档 `:226,524`                          |
| E21 | 生产按需启用 Queues/Workflows/DO/Images                                 | 三份 wrangler **全部不存在**这些绑定                                                                                    | 文档 `:247,534`                          |
| E22 | D1 迁移「随部署流水线执行」                                             | **CI 中无任何部署或迁移步骤**（无 wrangler 命令、无 secrets）                                                           | 文档 `:535` vs `ci.yml`                  |
| E23 | staging（main 自动部署）/ production（tag 部署）三套环境                | CI 中**完全不存在**环境分层；三份 wrangler 也**无 `env` 段**                                                            | 文档 §12.2 vs 实测                       |
| E24 | README 生产 checklist 要求替换 `PLACEHOLDER_LOCAL_DEV`                  | 三份 wrangler 中该占位符**命中 0 次**（D1/KV 均已填真实值）；checklist 项已过时                                         | `README.md`                              |
| E25 | README 称 admin「按域名分流双入口」                                     | wrangler **未配置任何 routes/自定义域** → hostname 分流**在生产无法生效**                                               | `README.md` + `apps/admin/wrangler.json` |

### 12.17.3 配置之间的不一致

| #   | 不一致                                                                                                                                                                                             | 证据                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| E26 | **turbo 的 `lint`/`typecheck`/`test` 声明 `dependsOn: ["^build"]`，但 `packages/{shared,db,auth,services}` 都没有 `build` script** → `^build` 对它们恒为空操作                                     | `turbo.json` + 各包 `package.json` |
| E27 | **`deploy` 任务重复构建**：turbo `deploy.dependsOn: ["build"]`，而 storefront/admin 的 `deploy` script 自身又是 `pnpm build && wrangler deploy` → 执行两次 build                                   | `turbo.json` + 两 app scripts      |
| E28 | **Prettier 在 CI 中完全未执行**：turbo 无 `format` task，CI 只跑 lint/typecheck/test/build                                                                                                         | `turbo.json` + `ci.yml`            |
| E29 | **`tooling/eslint/eslint.config.js` 用双引号，违反本仓 `.prettierrc.json` 的 `singleQuote: true`**（因 CI 不跑 Prettier 故未被发现）                                                               | 两文件                             |
| E30 | **根 `package.json` 装了 `@typescript-eslint/eslint-plugin` + `parser`，但无任何消费者**（`eslint.config.js` 只 import `@eshop/eslint-config`）；`tooling/eslint` 用的是聚合包 `typescript-eslint` | 根 + `tooling/eslint`              |
| E31 | **根 devDeps 含 `@eshop/auth: workspace:*` 属悬空依赖**（根不引用 auth 任何符号）；`apps/api` 声明 `@eshop/db` 但全仓 `import '@eshop/db'` **命中 0**                                              | 根 + `apps/api` package.json       |
| E32 | **`meta/` 快照数与 journal 条数不匹配**：journal 6 条 entry，`meta/` 只有 4 个 snapshot（`0000`–`0003`）；`0005`/`0006` 无快照                                                                     | `packages/db/migrations/meta/`     |
| E33 | **`0002_seed.sql` 头注释引用了不存在的文件名**：注释写 `--file=.../0001_seed.sql`，实际文件名是 `0002_seed.sql`                                                                                    | `0002_seed.sql`                    |
| E34 | **`apps/admin/tsconfig.json` 的 `include` 不含 `worker.ts`** → admin 的 `tsc --noEmit`（`build` 与 `typecheck` 都调用）**从不检查生产入口文件**                                                    | `apps/admin/tsconfig.json`         |
| E35 | **`tools/svg` 不在 pnpm workspace 内但被 git 跟踪**，`main: "index.js"` 指向**不存在的文件**（实际是 `.mjs`），且用独立 `package-lock.json` + npm                                                  | `tools/svg/package.json`           |
| E36 | **`packages/auth` 与 `packages/services` 未出现在 README 目录结构说明中**；`packages/services` 的职责声明**全仓任何文档均缺失**。另：`tools/`、`.github/` 同样未出现在结构块中（实测 `README.md:8-17` 仅列 `apps/{api,storefront,admin}` + `packages/{shared,db}` + `tooling/`） | `README.md`                        |

#### 12.17.3b 配置面补充清单（E37–E51，本轮新增，逐条实测）

| #   | 不一致                                                                                                                                                                                                                                | 证据                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| E37 | **升级缝 S1 的绑定从未落地**：`apps/api/src/lib/task-queue.ts` 用 `'ORDER_QUEUE' in env` 探测，但三份 wrangler 中 `ORDER_QUEUE` 与 `queues` 段**均 0 命中** → 该缝**永远无法激活**；`jobs/scheduler.ts` 也未引用 `getTaskQueue` | `lib/task-queue.ts` + 三份 wrangler                        |
| E38 | **7 个 workspace 执行 `eslint .` 但均未声明 `eslint` 依赖**（仅根与 `tooling/eslint` 的 peerDeps 有）；同理 `packages/{auth,db,services,shared}` 执行 `tsc --noEmit` 却**未声明 `typescript`**                                              | 9 份 package.json                                           |
| E39 | **`packages/auth/tsconfig.json` 的 `include: ["src"]` 排除了 `test/totp.test.mts`** → 该测试**不参与类型检查**；且它以 `.ts` 扩展名导入（`from '../src/totp.ts'`），而 `base.json` **无 `allowImportingTsExtensions`**（全仓 0 命中）        | `packages/auth/tsconfig.json` + `base.json`                 |
| E40 | **`packages/auth` 的 `test` 依赖 `node --experimental-strip-types`（需 Node ≥ 22.6），但根 `engines.node` 写 `>=20`** → 声明的最低版本**跑不了自家测试**（CI 用 node 22 故未暴露）                                                          | `packages/auth/package.json` + 根 `package.json`            |
| E41 | **`apps/storefront` 声明 `@cloudflare/workers-types`，但其 tsconfig 的 `types` 只有 `["vite/client"]`** → 该类型包**未被任何 tsconfig 引用**                                                                                            | `apps/storefront/tsconfig.json`                             |
| E42 | **`apps/admin` 声明 `dayjs: ^1.11.0` 但 `apps/admin/src` 中 `dayjs` 引用 0 次** → 死依赖                                                                                                                                              | `apps/admin/package.json` + `src`                           |
| E43 | **`apps/storefront/wrangler.json` 声明 `assets.binding: "ASSETS"`，但 `apps/storefront/app/**` 中 `ASSETS` 引用 0 次** → 绑定未被代码使用                                                                                              | `apps/storefront/wrangler.json`                             |
| E44 | **`apps/api/src/env.ts` 注释提到 `CACHE` 为可选绑定，但 `Env` 接口中无 `CACHE` 字段**；且 `R2: R2Bucket` 为**必填**、wrangler 已绑 `eshop-assets`，而全仓 `env.R2` 引用 **0 次**                                                              | `apps/api/src/env.ts`                                       |
| E45 | **`apps/storefront/app/load-context.ts` 的注释声称生产路径注入 `cf` 与 `caches`，实际 `getLoadContext` 只返回 `{ cloudflare: { env, ctx } }`** → 两个字段在生产不可用                                                                    | `app/load-context.ts:3` vs `:35-37`                         |
| E46 | **README 声称 deploy 有顺序（`api → storefront（SSR）→ admin`），turbo 无任何跨包顺序约束**：`deploy` 只有 `dependsOn: ["build"]`（同包）与 `cache: false`                                                                            | `README.md:61` + `turbo.json`                               |
| E47 | **`apps/storefront` 的 `start: wrangler dev` 缺少前置构建**：`wrangler.json` 的 `main: app/worker.ts` 静态 import `../build/server/index.js`，该文件**仅在 `react-router build` 后存在**，而 `start` 自身不 build                            | `apps/storefront/package.json` + `app/worker.ts`            |
| E48 | **同一仓库两份文档互相打脸**：`README.md:105` 自述「测试体系（当前仅 `packages/auth` 有 TOTP 单测）」，而 `docs/system-design.md:222` 的选型表写「Vitest（+ `@cloudflare/vitest-pool-workers`）、Playwright E2E」，`:540/:545` 还写了三级流水线含 E2E 底线 | `README.md` vs `docs/system-design.md`                      |
| E49 | **CI 的 `pnpm test` 实际只跑 1 个文件**：`turbo run test` 的 `dependsOn: ["^build"]` 需要各包有 `test` script，而 9 个 workspace 中**只有 `packages/auth` 有** → 该 CI 步骤「绿灯」但覆盖面≈单个 TOTP 文件                                     | `turbo.json` + `ci.yml` + 9 份 package.json                 |
| E50 | **`apps/admin/worker.ts` 的注释与 wrangler 配置不一致**：注释写 `assets.run_worker_first = ["/api/*"]`，`wrangler.json` 实为 `["/api/*", "/"]`（代码中确有 `/` 分支 302）                                                                | `apps/admin/worker.ts` vs `apps/admin/wrangler.json`        |
| E51 | **`apps/storefront` 声明 `@react-router/cloudflare` 但源码 0 引用**（`*.ts`/`*.tsx` 中命中 0；`vite.config.ts` 实际用的是 `@react-router/dev/vite/cloudflare`）                                                                        | `apps/storefront/package.json` + `vite.config.ts`           |

> **对两条「疑似」的证伪（避免误抄）**：镜像清点曾提出「`apps/api/.dev.vars` 被 git 跟踪」与「商品图全部缺失」。**实测均不成立**——`git ls-files` 中 `.dev.vars` **未被跟踪**（`.gitignore` 生效），且仓库中**确有 10 个 `.png`**（`apps/storefront/public/images/` 下）。这两条属镜像复制时的排除伪影，**不作为不一致计入**。这正是本节纪律的体现：**任何结论都要能用一条命令复现**。

### 12.17.4 对 DShop 的直接启示

1. **不要照抄 eshop 的「文档声称」**——eshop 的文档与实测偏差经彻底清点达 **51 处（E1–E51）**。DShop 的纪律应是「**文档里的每个数字都能被一条命令复现**」。
2. **eshop 的质量闸门有真实漏洞**：CI 不跑 Prettier、不跑部署/迁移 dry-run、admin 生产入口不被类型检查、`meta/` 快照与 journal 不匹配。DShop 的 `scripts/check.ts` 自动发现 + `wrangler deploy --dry-run` + 多环境 dry-run 循环**优于** eshop 的固定 turbo 编排。
3. **eshop 的测试体系几乎是空的**（全仓唯一 test 是 `packages/auth` 的单个 TOTP 文件，vitest/Playwright 在 lock 中零命中）。DShop 的 **275 个 API 测试 + 31 个缝测试**是实质优势。
4. **eshop 的 `task_queue` 用 `max_attempts` / `next_run_at`，DShop 用 `attempts` / `run_at`**——DShop 是有意简化（`max_attempts` 由代码常量 `TASK_MAX_ATTEMPTS` 承担，不入表）。**这不是偏离，是取舍**，但必须如实标注以免被误认为抄错。
5. **eshop 的真实绑定名是 `ORDER_QUEUE`，DShop 锁定为 `TASK_QUEUE`**——DShop 的命名更中性（该表不只服务订单）。**这是有意的改名**，需在文档中标注，避免「与参照物不一致」的误判。
