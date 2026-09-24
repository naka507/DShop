# DShop 架构设计 · 第 4 部分

> **内容**：§4 Cloudflare 资源与绑定清单、§4.3 升级缝 S1–S11 与触发阈值
> **导航**：[文档总目录](README.md) ｜ 上一部分：[03-工程结构与前端](03-工程结构与前端.md) ｜ 下一部分：[05-数据模型](05-数据模型.md)

---

## 4. Cloudflare 资源与绑定清单

### 4.1 Workers 与域名

| Worker 名 | 绑定域名 | 内容 |
| --- | --- | --- |
| `dshop-api` | **仅** `api.dshop.example.com/*` | Hono 全部路由组 + Cron 单一入口 + TaskQueue 消费 + **`/api/v1/agent/*`** |
| `dshop-storefront` | `www.dshop.example.com/*` | React Router SSR + Workers Assets 静态资源；**薄 worker 转发本站 `/api/*` → `dshop-api`（Service Binding）** |
| `dshop-admin` | `admin.dshop.example.com/*`、`merchant.dshop.example.com/*` | 后台静态 SPA（Assets + SPA fallback）+ **薄 worker 转发本站 `/api/*` → `dshop-api`（Service Binding）** |

> **`/api/*` 的归属**：`www` / `admin` / `merchant` 三个域下的 `/api/*` **不占用 `dshop-api` 的 routes**，而是由 `dshop-storefront` 与 `dshop-admin` 各自的 Worker 在**内部**用 Service Binding 转发到 `dshop-api`（三者同属 Cloudflare 托管 zone 的子请求会保留 `Host` 头并被路由绕回发起方自身，表现为静默 404）。`dshop-api` 自身只绑定 `api.dshop.example.com/*`；Service Binding 同时保证 HttpOnly Cookie 同源携带。

> **PiEcho 只依赖 `api.dshop.example.com`**：PiEcho 的 `ESHOP_BASE_URL` 指向该域（§14.2 C5）。因此**该域的可达性是 PiEcho 的前置条件（P4）**——测试部署无需备案，用默认 `*.workers.dev` 或自定义域均可（§11.3）；但**部署位置必须能被 PiEcho 访问**（PiEcho 走公网调用，其所在位置须能访问 Cloudflare）。`*.workers.dev` 在大陆不可达这一事实仍然成立，本项目不承诺大陆可达。

### 4.2 绑定清单（binding name 为准）

| 资源类型 | 绑定名 | 所在 Worker | 用途 |
| --- | --- | --- | --- |
| D1 | `DB` | api / storefront | 主数据库（读写）；storefront 仅只读使用 |
| D1 | `AGENT_DB` | api（**按需，见 S11 触发阈值**） | 升级缝 S11：D1 只读副本 / Sessions API，专供 Agent 组读路径 |
| KV | `KV` | api / storefront | 低频配置、黑名单、验证码计数、会话吊销**读缓存**（**单一真相源是 D1 的 `refresh_tokens.revoked_at`**，KV 仅作读缓存、非真相源）（**Agent 限流计数不落 KV**，见 §7.8.4） |
| R2 | `R2` | api | 商品图、资质文件、售后凭证、冷数据归档 |
| R2 | `R2_PUBLIC` | api | **与 `R2` 是同一个桶**（`dshop-assets`）的公开只读入口，自定义域 `img.dshop.example.com` 指向该桶（或该桶下的 `public/` 前缀）；两个绑定名只是代码里的访问语义区分（`R2` 走 S3 API 读写、`R2_PUBLIC` 走自定义域只读 URL），**不额外创建桶**——故 §10.3 只创建一次 `dshop-assets` |
| **Durable Object** | `AGENT_RL` | api（**默认启用**） | Agent 组限流计数器：**全局精确配额**。Cache API 作为降级路径（§7.8.4）。免费层即可用 |
| Cron Triggers | `triggers.crons: ["* * * * *"]` | api | **单一入口每分钟**，内部分发：task_queue 消费、超时关单、自动收货、结算生成、券过期、物流轨迹同步、Agent 调用日志落库 |
| Queues | `ORDER_QUEUE` | api（**按需**） | 升级缝 S1：存在即 `TaskQueue` 自动切原生队列 |
| Service Binding | `API` | storefront / admin | 各自 Worker 把本站 `/api/*` 同源转发到 `dshop-api`（`dshop-api` 不绑定 `www/admin/merchant` 域） |
| Secrets | `JWT_SECRET` / `AGENT_TOKEN_PEPPER` / `AGENT_SIGN_SECRET`（可选签名，默认不启用） / `WXPAY_*` / `ALIPAY_*` / `SMS_*` | api | `wrangler secret put` 管理，禁止写入 `wrangler.jsonc` |

### 4.3 升级缝（Upgrade Seams）

**设计纪律**：Cloudflare 付费组件**一律不直接 import**，全部藏在自研接口后面（`wrangler.jsonc` 绑定 + 适配器切换）。**一条缝 = 一个可独立开关的实现替换点**（形态可能是**绑定**、**账户计划**、**代码单点**、**配置项**）：默认形态下走零配置实现，打开开关即切升级实现，关掉即回滚。缝与缝之间零耦合，可按「单缝 × 单环境」灰度。

**编号约定**：**S1–S9 沿用通用商城（`eshop`）的原始编号**，逐条一一对应，便于与通用商城设计互相对照与评审（特别地：**S7 是缓存、S8 是限流、S9 是出海/多区、S3b 是 CPU 密集任务**）；DShop 相对通用商城**新增的缝排在末尾，用 S10 / S11**，不复用既有编号。

| # | 升级缝 | 默认实现（零配置） | 按需升级为 | 开关方式 |
| --- | --- | --- | --- | --- |
| S1 | 异步任务 | D1 `task_queue` + Cron 轮询 | Cloudflare Queues | 加/删 `ORDER_QUEUE` 绑定，运行时自动检测 |
| S2 | 数据库读扩展 | 单库直连 + Cache API | D1 只读副本（Sessions API） | services 读连接加 `withSession` 配置 |
| S3 | 密码哈希 | PBKDF2（WebCrypto） | argon2id | `packages/auth` 哈希函数单点替换，惰性升级存量 |
| **S3b** | **CPU 密集任务** | Cron 分批小步处理 | Workers Paid CPU 档位 | 账户级计划，无应用配置 |
| S4 | 实时推送 | 前端轮询（Cache API 防抖） | Durable Objects WebSocket / SSE | 前端 `OrderStatusSource` 抽象换实现 |
| S5 | 搜索 | D1 `LIKE` + 简单分词 | Vectorize / 外置搜索服务 | services 层商品读接口换实现 |
| S6 | 图片加工 | 上传时生成固定尺寸 | Image Resizing / Cloudflare Images | Dashboard 平台配置 |
| **S7** | **缓存** | Cache API 边缘缓存 | 叠加热点 KV / 缓存层 | 按需叠加（新增 KV 绑定即生效，属「配置项」形态，不涉及实现替换） |
| **S8** | **限流** | 应用层自研（Hono 中间件 + **Cache API 固定窗口计数**，不写 KV） | WAF 自定义限流规则；**Agent 组默认启用 Durable Object 全局计数**（本版调整） | Dashboard 平台配置，应用层保留兜底 |
| **S9** | **出海 / 多区** | 单区域 D1 | 多区域副本 + 地理路由 | 同 S2 + Cloudflare 地理路由（**远期选项**） |
| **S10** | **Agent API 部署形态** | 与 `dshop-api` 同 Worker（同代码库、独立路由与中间件链） | 独立 Worker `dshop-agent-api` | 新增 Worker 配置 + 复制 `DB`/`KV` 绑定，代码复用 `packages/services`；**触发阈值见下** |
| **S11** | **Agent 读扩展** | 复用 `DB` | `AGENT_DB` 只读副本 | Agent 组读客户端按 `env.AGENT_DB` 是否存在自动选择；**触发阈值见下** |

> S10/S11 是 DShop 相对通用商城的额外两条缝——动机是**把 Agent 流量对商城主链路的影响降到零**（P5）：Agent 流量突发时，先靠 S11 隔离读，再靠 S10 隔离部署与配额。

> **S10 / S11 触发阈值（本版新增，从「后续演进」升级为条件触发项）**：满足**任一**条件即启用——① 日客服会话 > 2 万；② Agent 流量占 API 总请求 > 30%；③ Agent 读导致 D1 读延迟 P95 > 100ms；④ 商城发布窗口与 PiEcho 联调窗口冲突且无法协调。阈值由 `agent_call_logs` 与 Workers Analytics 持续监测，M2 起纳入运营看板（§12）。

> **Durable Objects 的可用性说明**：Cloudflare 现已为 Durable Objects 提供**免费层**（需在 `wrangler.jsonc` 声明 `migrations` 与 `durable_objects` 绑定），故 S4（实时推送）与 S8（限流计数器）的升级目标**在 dev/preview 免费层即具备可用性**，不再是「付费层专属」；免费层的主要约束是**配额与限流**（见 §10.1），而非功能缺失。这也意味着 S4/S8 的开关可以是「绑定存在性」——与其余缝一致。

---
