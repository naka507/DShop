# `scripts/` —— DShop 工具脚本

> 本目录是**唯一**允许存放仓库级工具脚本的位置（`docs/03` §3.1）。
> 全部脚本用 `tsx` 运行（依赖已在根 `devDependencies` 中，**无需 `npm install`**）。
>
> 约束：TS strict + `verbatimModuleSyntax`（类型导入用 `import type`）；相对导入带 `.js` 后缀；
> 不引入新的 npm 依赖（OpenAPI 用 **zod v4 内置的 `z.toJSONSchema()`**）。

| 脚本                    | 用途                                                 | 副作用                              |
| ----------------------- | ---------------------------------------------------- | ----------------------------------- |
| `export-openapi.ts`     | 由 Zod 契约导出 OpenAPI 3.1                          | 写 `docs/openapi/agent.v1.json`     |
| `build-seed-sql.ts`     | 由 JSON 生成/刷新种子 SQL（现场派生 PII 密文与哈希） | 写 `data/seed-cs/seed_cs.sql`       |
| `seed-service-token.ts` | 签发服务令牌并打印可执行 SQL                         | **只写 stdout**，绝不写文件         |
| `seed-admin.ts`         | 创建/重置首个超管，打印可执行 SQL（现场派生口令哈希与 TOTP 密钥） | **只写 stdout**，绝不写文件         |
| `load-seed-local.ts`    | 把迁移与种子加载进 D1                                | 写本地 D1（`--remote` 则写真实 D1） |
| `check.ts`              | 聚合自检（tsc + vitest + 种子校验）                  | 无                                  |
| `e2e-customer-journey.ts` | C 端全链路验收：真实浏览器（零依赖 CDP）走「登录 → 加购 → 结算 → 下单」，再比对 Agent 面与 C 端状态一致性 + 客服对话腿 | 写本地 D1（自造用户/地址/订单/临时令牌，跑完即清）；起 DShop API、storefront、PiEcho 网关三个进程 |
| `lib/png-image.ts`（库） | 零依赖 PNG 生成器：把 `gen:png?hue=&seed=&size=` 指令确定性展开为 `data:image/png;base64,…` | 无（纯函数，被 `build-seed-sql.ts` 引用） |

---

## 1. `export-openapi.ts`

```bash
npx tsx scripts/export-openapi.ts     # 等价于 npm run openapi
```

- 用 `z.toJSONSchema()` 把 `@dshop/shared` 的全部 `*Schema` 转 JSON Schema；注册名 = 导出名，
  因此文档里统一用 `$ref` 引用 `components.schemas`，不重复内联。
- 输出 `docs/openapi/agent.v1.json`：`openapi: "3.1.0"`、`info.version = "1"`（契约版本
  `CONTRACT_VERSION_CURRENT`）、`servers`、`paths`（六条，取自 `AGENT_ENDPOINTS`）、
  `components.securitySchemes` + `components.schemas`。
- **幂等**：键按字典序深排序 + 缩进 2 空格；zod 产生的匿名 `$defs`（`__schemaN`）按内容
  SHA-256 前 8 位重命名为 `AnonSchema<hash>`，故多次运行**字节级一致**。
- stdout 打印：文件路径、`paths` 数量、`components.schemas` 数量、字节数。

### 实现侧定案（OpenAPI）

| 项                             | 定案                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| security scheme 名             | **`ServiceToken`**（`type: apiKey`、`in: header`、`name: X-Service-Token`）                                                                                                            |
| 错误响应 schema 名             | **`AgentErrorResponse`**（即 `AgentEnvelopeSchema`：`{code, message, data}`）                                                                                                          |
| 错误 response 覆盖的 HTTP 状态 | 由 `AGENT_ERROR_META` 推导：`400 / 401 / 403 / 404 / 405 / 409 / 429 / 500`                                                                                                            |
| 200 响应 body                  | 统一信封：**`<端点>SuccessResponse`**（如 `AgentOrderDetailSuccessResponse` = `{code:0, message:"ok", data:<端点 data Schema>}`）；`data` 以 `$ref` 复用端点 component，不内联重复展开 |
| 路径                           | `AGENT_ROUTE_PREFIX` + 端点 path，`:param` → `{param}`                                                                                                                                 |
| `operationId`                  | `listAgentOrders` / `getAgentOrderByNo` / `getAgentProductSpecs` / `getAgentProductStock` / `getAgentAftersaleByNo` / `getAgentPolicies`                                               |
| 扩展字段                       | `x-agent-scope`、`x-rate-limit-per-min`、`x-burst`、`x-cache-ttl-seconds`（取自 `AGENT_ENDPOINTS`）                                                                                    |
| `servers`                      | `https://api.dshop.example.com`（07 §7.2 Base URL 的 origin）+ `http://localhost:8787`                                                                                                 |
| 成功响应 schema 名             | **`<端点 data Schema 去掉 Schema>SuccessResponse`**（六端点各一个，如 `AgentOrderDetailSuccessResponse`）；`data` 为 `$ref` 指向对应 data component                                    |

## 2. `build-seed-sql.ts`

```bash
npx tsx scripts/build-seed-sql.ts     # 等价于 npm run seed:sql
```

- 读 `data/seed-cs/{products,product_attrs,aftersale_policies,orders,aftersales,users}.json`。
- `merchants` / `stores` / `categories` **不在任何 JSON 中**（JSON 只引用其 id），取值照
  `data/seed-cs/README.md` §4 第 14/15 项的定案，作为脚本内常量。
- `users.phone`（AES-256-GCM 密文）与 `users.phone_hash`（HMAC-SHA256）由
  `@dshop/auth` 的 `encryptPii()` / `hashPhone()` **用运行环境密钥现场派生**。
- 语句版式：`INSERT INTO <table> (<cols>) VALUES (...), (...) ON CONFLICT(<唯一键>) DO UPDATE SET ...;`
  单引号转义为 `''`；JSON 列写字符串字面量；列名 snake_case；冲突键照 `docs/M0-字段契约.md` §12。
- **图片字段**：JSON 里存的是生成指令 `gen:png?hue=<0-359>&seed=<n>&size=<8-1024>`，
  本脚本调 `lib/png-image.ts` 的 `expandGenDirective()` 在构建期展开成
  `data:image/png;base64,…`（真实 PNG 字节，浏览器可直接解码）。
  覆盖列：`products.main_image`(512) / `product_images.url`(256) / `users.avatar_url`(64) /
  `order_items.image`(256) / `aftersales.evidence_urls`(256) /
  `merchants.logo_url` + `merchants.qualification_urls`(256，脚本内常量)。
  **不引入任何外部图片依赖**，也不改表结构、不加接口、不加 CSP。
- 保持文件顶部注释（虚构数据集 + **不得进生产**）。
- stdout 打印：写出行数、`INSERT INTO` 计数、`ON CONFLICT` 计数（两者必须相等）、表数、记录数、字节数。

### 环境变量

| 变量                | 默认值（开发）                | 用途                                                         |
| ------------------- | ----------------------------- | ------------------------------------------------------------ |
| `PHONE_ENC_KEY`     | `dshop-dev-phone-enc-key`     | `users.phone` 的 AES-GCM 密钥材料（经 SHA-256 派生 32 字节） |
| `PHONE_HASH_PEPPER` | `dshop-dev-phone-hash-pepper` | `users.phone_hash` 的 HMAC-SHA256 胡椒                       |

未设置时**打印醒目警告**，并在 SQL 头部注明「本次生成使用了开发默认密钥」。

### 幂等性说明

`encryptPii()` 内部用 `crypto.getRandomValues` 生成 12 字节 IV，天然不可重复。
本脚本在调用期间**临时替换** `crypto.getRandomValues` 为「由 `PHONE_ENC_KEY + 手机号`
经 FNV-1a/xorshift32 派生的确定性字节流」，调用后立即恢复。
因此同一密钥下重复运行产出**字节级一致**（时间字段一律取自 JSON 或脚本内常量，**不用 `new Date()`**）。

> ⚠️ 确定性 IV 只用于 **dev/staging 种子数据**（同一手机号本就该得到同一密文）。
> 生产签发/写入路径**不得**复用该技巧。

### 实现侧定案（种子 SQL）

| 项                                             | 定案                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `merchants` / `stores` / `categories` 数据来源 | 脚本内常量（照 `data/seed-cs/README.md` §4 第 14/15 项）                                                                                                                                                                                                                                                                             |
| `product_attrs.created_at` / `updated_at`      | JSON **未提供**该字段 → 用常量 `2026-06-01T02:00:00.000Z` / `2026-09-18T03:00:00.000Z`（与改动前的 `seed_cs.sql` 一致）                                                                                                                                                                                                              |
| `order_status_logs.created_at`                 | 取该行 `occurred_at`（JSON 未单独提供）                                                                                                                                                                                                                                                                                              |
| `aftersale_logs.created_at`                    | 取该行 `occurred_at`（同上）                                                                                                                                                                                                                                                                                                         |
| `product_images.created_at`                    | 取所属商品的 `created_at`（同上）                                                                                                                                                                                                                                                                                                    |
| 表/记录数                                      | 15 表 128 行：`merchants` 1 / `stores` 2 / `categories` 5 / `products` 2 / `product_skus` 4 / `product_attrs` 55 / `product_images` 4 / `orders` 3 / `sub_orders` 5 / `order_items` 5 / `order_status_logs` 22 / `aftersales` 3 / `aftersale_logs` 9 / `aftersale_policies` 5 / `users` 3（与 `data/seed-cs/README.md` §1 完全一致） |

## 3. `seed-service-token.ts`

```bash
npx tsx scripts/seed-service-token.ts
npx tsx scripts/seed-service-token.ts --name "PiEcho 生产令牌" --scopes agent:order:read --rate-limit 1200 --days 90
```

| 参数                    | 默认              | 说明                                                                 |
| ----------------------- | ----------------- | -------------------------------------------------------------------- |
| `--name <名称>`         | `PiEcho Agent`    | 令牌名称                                                             |
| `--scopes <逗号分隔>`   | 全部 4 个读 scope | 取值照 `packages/shared/src/enums.ts` 的 `AGENT_SCOPE`；非法值即报错 |
| `--rate-limit <每分钟>` | `600`             | 令牌级限流（`SERVICE_TOKEN_DEFAULT_RATE_LIMIT_PER_MIN`）             |
| `--days <有效期天数>`   | `180`             | 有效期（`SERVICE_TOKEN_TTL_DAYS`）                                   |

输出：① 明文令牌（醒目提示「仅显示一次，请立即保存」）② 可执行
`INSERT INTO service_tokens (...) VALUES (...) ON CONFLICT(token_hash) DO UPDATE SET ...;`
（`id` 用 `newId()` 生成 ULID，`created_at` / `updated_at` 用当前 UTC ISO，`expires_at` = now + days）
③ `token_prefix` / `expires_at` / `scopes` 摘要。

**环境变量**：`AGENT_TOKEN_PEPPER`（默认 `dshop-dev-agent-token-pepper`，使用时警告）。

> ⚠️ **明文令牌绝不写入任何文件**；本脚本只读环境变量、只写 stdout。
>
> 实现侧定案：`created_by` 写固定串 `seed-service-token.ts`（生产由后台账号 id 填充）。
> 生产签发应走 `POST /api/v1/admin/agent-tokens`（强制 TOTP + 落审计，07 §7.8.1）。
>

## 4. `seed-admin.ts`

```bash
ADMIN_INITIAL_PASSWORD='<强口令，≥12 位>' npx tsx scripts/seed-admin.ts    # 等价于 npm run seed:admin
ADMIN_INITIAL_PASSWORD='...' npx tsx scripts/seed-admin.ts --username ops --role platform_operator
ADMIN_INITIAL_PASSWORD='...' npx tsx scripts/seed-admin.ts --rotate-totp   # 重发 TOTP 密钥
```

| 参数             | 默认                   | 说明                                                                          |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `--username`     | `admin`                | 登录名（须匹配 `uq_admin_users_username`）                                    |
| `--nickname`     | `平台超管`             | 显示名                                                                        |
| `--role`         | `platform_super_admin` | 绑定角色，取值照 `roles.code`（`0002_seed.sql` 内置 8 个）                     |
| `--no-totp`      | 关                     | **不**签发 TOTP 密钥（⚠️ 该账号将**永久无法**签发 Agent 服务令牌）             |
| `--rotate-totp`  | 关                     | 账号已存在时也重发 TOTP 密钥（默认保留已绑定的验证器，避免重设口令踢掉 2FA）  |

**环境变量**：`ADMIN_INITIAL_PASSWORD`（**必填**，无默认值，长度 ≥ 12）。

输出：① TOTP 密钥 + `otpauth://` 配置 URI（**仅显示一次**）② 幂等
`INSERT INTO admin_users ... ON CONFLICT(username) DO UPDATE SET ...;`
与 `INSERT INTO admin_user_roles ... ON CONFLICT(admin_user_id, role_id) DO NOTHING;`
（两个 id 用 `newId()` 生成 ULID；关联行的 `admin_user_id` / `role_id` 用**自然键子查询**解析，
避免 `DO UPDATE` 不改主键时随机 id 挂空）③ 摘要（账号 / 角色 / TOTP / 哈希前缀）。

> ⚠️ **明文口令与 TOTP 密钥绝不写入任何文件**；只读环境变量、只写 stdout。
> 口令**不走命令行参数**（会落入 shell 历史），只能经环境变量注入。

### 为什么需要本脚本

`0002_seed.sql` 按 `docs/M0-字段契约.md` §11 **不插入** `admin_users`（口令哈希不得硬编码），
且 `build-seed-sql.ts` 的产物 `data/seed-cs/seed_cs.sql` 仅供 dev/staging（文件头明确
「生产环境不得导入」），**结构上无法** bootstrap 生产超管。故生产首个超管只能由本脚本创建。
它是 `seed-service-token.ts` 的前置：没有超管就登不进后台，也就签不出服务令牌。

> ⚠️ 必须启用 TOTP：`POST /api/v1/admin/agent-tokens` **强制二次验证**，
> `totp_enabled = 0` 的账号会拿到 `TOTP_REQUIRED`（`docs/09` §9.2 / `docs/07` §7.8.1）。

---

## 5. `load-seed-local.ts`

```bash
npx tsx scripts/load-seed-local.ts            # 本地 D1（默认）
npx tsx scripts/load-seed-local.ts --remote   # ⚠️ 写真实 D1
```

按顺序逐条执行 `wrangler d1 execute dshop-dev <--local|--remote> --config=apps/api/wrangler.jsonc --file=<path>`：

1. `packages/db/migrations/0001_init.sql`（41 表 schema）
2. `packages/db/migrations/0002_seed.sql`（业务 seed：roles / settings）
3. `data/seed-cs/seed_cs.sql`（虚构客服场景数据集）

实现：`node:child_process` 的 `spawnSync` + `shell: true`（Windows 兼容），逐条检查退出码；
任一步失败立即中止并打印 stderr（`stdio: "inherit"`）。

> ### ⚠️⚠️ `--remote` 会写**真实数据库**
>
> - 不带开关时只写**本地** D1（`.wrangler/state`），**无外部副作用**。
> - 带 `--remote` 时写 Cloudflare 上的真实 D1；操作**不可撤销**。
> - **M0 阶段禁止对生产环境使用**。`data/seed-cs/seed_cs.sql` 是**虚构数据**，
>   生产环境不得导入（`docs/M0-实施简报.md` §7.1 / `docs/10` §12.3）。
> - 脚本在启用 `--remote` 时会先打印醒目警告。

## 6. `check.ts`

```bash
npx tsx scripts/check.ts
```

依次执行 11 个子任务（每个单独计时，失败不阻断后续）：

| #    | 子任务                                                    |
| ---- | --------------------------------------------------------- |
| 1–2  | `packages/shared` → `npx tsc --noEmit` / `npx vitest run` |
| 3–4  | `packages/db` → 同上                                      |
| 5–6  | `packages/auth` → 同上                                    |
| 7–8  | `packages/services` → 同上                                |
| 9–10 | `apps/api` → 同上                                         |
| 11   | `node data/seed-cs/verify.mjs`                            |

汇总打印每个子任务的结果与耗时；**任一失败则整体退出码非 0**。

> `vitest run` 在**没有任何测试文件**的 workspace 会以退出码 1 退出（`No test files found`）。
> 本脚本把这种情况标记为 `NO-TESTS` 并**不计为失败**。
>
> M0 收尾时 5 个包**均已有测试**（`packages/shared` 23+21 例、`apps/api` 33 例等），
> 当前 11 个子任务全为 `PASS`，无 `NO-TESTS`。

---

## 7. 密钥类环境变量清单

| 变量                 | 使用脚本                | 用途                                                     | 开发默认值                     | 生产               |
| -------------------- | ----------------------- | -------------------------------------------------------- | ------------------------------ | ------------------ |
| `PHONE_ENC_KEY`      | `build-seed-sql.ts`     | `users.phone` 的 AES-256-GCM 密钥材料                    | `dshop-dev-phone-enc-key`      | **必须注入真实值** |
| `PHONE_HASH_PEPPER`  | `build-seed-sql.ts`     | `users.phone_hash` 的 HMAC-SHA256 胡椒                   | `dshop-dev-phone-hash-pepper`  | **必须注入真实值** |
| `AGENT_TOKEN_PEPPER` | `seed-service-token.ts` | `service_tokens.token_hash = HMAC-SHA256(pepper, token)` | `dshop-dev-agent-token-pepper` | **必须注入真实值** |
| `ADMIN_INITIAL_PASSWORD` | `seed-admin.ts` | 首个超管的初始口令（**必填**，无默认值，≥12 位）        | 无（不提供默认值）             | **必须注入真实值** |

其它由运行环境（`apps/api` 的 `env`）提供、但本目录脚本**不读取**的密钥：
`JWT_SECRET`（HS256 签名）、`AGENT_SIGN_SECRET`（可选请求签名加固，开关
`settings.agent_require_signature` 默认关闭）。见 `docs/09` §9.1 / `docs/07` §7.8.1。

> **三个开发默认值仅用于 dev/staging**，与生产密钥无关；脚本在回退到默认值时一律打印警告。
> 生产环境必须通过 `wrangler secret put` 注入真实值后重新生成派生数据。

---

## 8. 实现侧定案汇总（本目录）

1. OpenAPI：security scheme 名 `ServiceToken`；错误 component 名 `AgentErrorResponse`；
   成功 component 名 `<端点 data Schema>SuccessResponse`（`{code:0, message:"ok", data:<data Schema $ref>}`），
   200 body 为**完整信封**。
2. OpenAPI：匿名 `$defs` 重命名为 `AnonSchema<sha256前8位>`；输出键深排序保证幂等。
3. 种子 SQL：`merchants` / `stores` / `categories` 为脚本内常量；`product_attrs` 与各日志表的
   缺失时间字段用固定常量或同记录内既有时间字段补齐（见 §2 表）。
4. 种子 SQL：AES-GCM IV 由「密钥 + 手机号」确定性派生，换取字节级幂等（仅 dev）。
5. 服务令牌：`created_by` 写 `seed-service-token.ts`；明文只出 stdout。
6. `load-seed-local.ts`：默认 `--local`；`--remote` 打印醒目警告（M0 禁止对生产使用）。
7. `check.ts`：`vitest run` 的 `No test files found` 视为 `NO-TESTS`，不计为失败。
8. 种子图片：**全部由脚本生成**，不依赖任何外部图床。JSON 存 `gen:png?hue=&seed=&size=` 指令，
   `lib/png-image.ts` 在构建期展开为 `data:image/png;base64,…`（真实 PNG，确定性）。
   约定边长：商品主图 512、图库/订单快照/售后凭证/商户图 256、头像 64。
   `data/seed-cs/verify.mjs` §11 断言「无外链 / 指令参数合法 / SQL 里是真 PNG 且边长与数量对得上」。

---

## 9. `lib/png-image.ts`

```bash
# 无 CLI；被 scripts/build-seed-sql.ts 以库形式引用
```

**零依赖**（只用 `node:zlib` + 手写 CRC32/Adler32/base64），不引入任何 npm 包。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `GEN_DIRECTIVE_PREFIX` | `"gen:png?"` | 指令前缀 |
| `renderPng` | `(size, hue, seed) => Uint8Array` | 生成 `size×size` 的真彩色 PNG 字节 |
| `pngDataUri` | `(size, hue, seed) => string` | 同上，包成 `data:image/png;base64,…` |
| `expandGenDirective` | `(value: string) => string` | 把 `gen:png?…` 展开为 data URI；**非该前缀原样返回** |

**严格校验**：`size ∈ [8,1024]`、`hue ∈ [0,359]`、`seed ∈ [0, MAX_SAFE_INTEGER]` 的整数；
参数缺失 / 重复 / 未知 / 非十进制整数一律 `throw`（本项目纪律：失败要响，不静默回落）。

**确定性**：只用 `hue` / `seed` 驱动像素，不用 `Math.random()`、不用 `new Date()`，
因此同一指令永远产出**字节级一致**的 PNG（`seed_cs.sql` 可重复生成且哈希稳定）。

**为什么不用手写 zlib stored block**：`node:zlib` 的 `deflateSync()` 返回的就是
**完整 zlib 流**（`0x78` 头 + deflate + Adler-32），可直接作为 `IDAT` 内容，
无需二次封装。实测 256×256 压缩后 3 647 B，手写 stored block 约 197 KB（**约 54 倍**差距）。
