# `data/seed-cs/` —— DShop 客服场景数据集（虚构）

> **⚠️ 本目录是虚构的客服场景数据集**，仅供**开发 / staging** 导入与验收使用。
> 依据 **Q6 决策**：M0 允许使用虚构场景数据（`docs/10` §12.3 默认设计）。
> **生产环境不得导入**本目录中的任何订单 / 售后 / 会员数据（`docs/M0-实施简报.md` §7.1）。
>
> 列名唯一基准：`docs/M0-字段契约.md`（snake_case）。
> 枚举唯一基准：`packages/shared/src/enums.ts`。
> 单号与时区规则：`packages/shared/src/ids.ts`。

---

## 1. 数据集总览

| 文件 | 内容 | 记录数 | 字节数 | 行数 |
| --- | --- | --- | --- | --- |
| `products.json` | 2 个 SPU（含 SKU、图片、规格维度） | **2 SPU / 4 SKU / 4 图片** | 4 559 | 118 |
| `product_attrs.json` | 商品参数（7 个分组） | **55** | 12 853 | 70 |
| `aftersale_policies.json` | 售后政策（markdown 正文） | **5** | 6 637 | 72 |
| `orders.json` | 订单（含子单 / 商品快照 / 状态日志与物流轨迹） | **3 订单 / 5 子单 / 5 商品项 / 22 日志** | 17 213 | 506 |
| `aftersales.json` | 售后单（含时间线） | **3 售后单 / 9 时间线行** | 6 491 | 181 |
| `users.json` | 会员（明文手机号 + phone_hash 占位） | **3** | 1 407 | 38 |
| `seed_cs.sql` | 幂等 SQL（由上述 JSON 生成） | **15 条 INSERT**（`merchants` 1 / `stores` 2 / `categories` 5 / `products` 2 / `product_skus` 4 / `product_attrs` 55 / `product_images` 4 / `orders` 3 / `sub_orders` 5 / `order_items` 5 / `order_status_logs` 22 / `aftersales` 3 / `aftersale_logs` 9 / `aftersale_policies` 5 / `users` 3） | 49 843 | 340 |
| `verify.mjs` | 零依赖自检脚本（50 项断言） | — | 30 107 | 683 |
| `README.md` | 本文件 | — | — | — |

`seed_cs.sql` 统计：**`INSERT INTO` 15 条 / `ON CONFLICT` 15 条**（数量必须相等，`verify.mjs` 断言）。

---

## 2. UTC+8 单号 ⇔ UTC 时间字段 对照表

**时区陷阱**：单号内嵌时间戳是 **UTC+8**（`Asia/Shanghai`），所有时间字段（`created_at` / `occurred_at` / `shipped_at` …）是 **UTC ISO-8601**。
`packages/shared/src/ids.ts` 的 `ID_TIMESTAMP_OFFSET_MINUTES = 480`。

### 2.1 主单号（`order_no`，14 位秒级时间戳 + 3 位当秒序列）

| `order_no` | 内嵌时间戳（UTC+8） | `orders.created_at`（UTC） | `orders.status` |
| --- | --- | --- | --- |
| `DS20260920143000123` | 2026-09-20 14:30:00 | `2026-09-20T06:30:00.000Z` | `SHIPPED` |
| `DS20260916142000001` | 2026-09-16 14:20:00 | `2026-09-16T06:20:00.000Z` | `COMPLETED` |
| `DS20260921103000456` | 2026-09-21 10:30:00 | `2026-09-21T02:30:00.000Z` | `PAID` |

### 2.2 子单号（`sub_order_no` = 主单号 + `-` + 2 位序号；时间戳继承主单）

| `sub_order_no` | 内嵌时间戳（UTC+8） | `sub_orders.created_at`（UTC） | `status` | 快递 |
| --- | --- | --- | --- | --- |
| `DS20260920143000123-01` | 2026-09-20 14:30:00 | `2026-09-20T06:30:00.000Z` | `SHIPPED` | 中通快递 / `ZT9988776655` |
| `DS20260920143000123-02` | 2026-09-20 14:30:00 | `2026-09-20T06:30:00.000Z` | `SHIPPED` | 顺丰速运 / `SF1029384756` |
| `DS20260916142000001-01` | 2026-09-16 14:20:00 | `2026-09-16T06:20:00.000Z` | `COMPLETED` | 顺丰速运 / `SF1029384756` |
| `DS20260921103000456-01` | 2026-09-21 10:30:00 | `2026-09-21T02:30:00.000Z` | `PAID` | — |
| `DS20260921103000456-02` | 2026-09-21 10:30:00 | `2026-09-21T02:30:00.000Z` | `CANCELLED` | — |

### 2.3 售后单号（`aftersale_no`，8 位 `YYYYMMDD` UTC+8 + 3 位当日序列）

售后单号只内嵌**日期**（不含时分秒），`verify.mjs` 断言「内嵌日期 == `created_at` 换算到 UTC+8 后的日期」。

| `aftersale_no` | 内嵌日期（UTC+8） | `aftersales.created_at`（UTC） | `status` |
| --- | --- | --- | --- |
| `AS20260922001` | 2026-09-22 | `2026-09-22T01:00:00.000Z`（UTC+8 09:00） | `WAIT_BUYER_RETURN` |
| `AS20260921001` | 2026-09-21 | `2026-09-21T01:30:00.000Z`（UTC+8 09:30） | `REFUNDED` |
| `AS20260917001` | 2026-09-17 | `2026-09-17T01:10:00.000Z`（UTC+8 09:10） | `PENDING_MERCHANT` |

### 2.4 其他关键时间字段（全部 UTC）

| 字段 | 值 |
| --- | --- |
| `DS20260920143000123.paid_at` | `2026-09-20T06:31:22.000Z` |
| `DS20260920143000123-01.shipped_at` | `2026-09-20T09:00:00.000Z` |
| `DS20260920143000123-02.shipped_at` | `2026-09-20T09:30:00.000Z` |
| `DS20260916142000001.completed_at` | `2026-09-17T06:20:00.000Z` |
| 政策 `effective_from`（5 条） | `2026-06-01T00:00:00.000Z` |

---

## 3. 四个 Golden 场景的数据支撑（逐条）

### 场景① 产品参数边界与客诉纠纷（「戴着游泳进水了，要退货」）

**依赖数据**：`product_attrs`（防水等级 + 使用禁忌）+ `aftersale_policies`（人为损坏 / 运费）+ `orders` / `aftersales`。

1. **`product_attrs` 中 Pro 的 `防护等级` 分组**（`spu_id = 01J9Z8K2M4N5P6Q7R8S9T0V1W2`）逐条给出判据：

   | `attr_name` | `attr_value` | `unit` | `sort_order` |
   | --- | --- | --- | --- |
   | 防水等级 | `IPX5` | null | 17 |
   | 防尘等级 | `无（IPX5 不含防尘等级）` | null | 18 |
   | 充电仓防水等级 | `不防水（IPX0）` | null | 19 |
   | 防水范围说明 | `耳机本体仅防日常出汗与轻度小雨泼溅，不承受水流冲洗与浸泡` | null | 20 |
   | 使用禁忌 | `不可游泳、淋浴、浸泡；充电仓不防水。禁止佩戴游泳/潜水/泡温泉，禁止用水龙头直接冲洗；进液导致短路属人为损坏，不在保修范围` | null | 21 |
   | 防水保修范围 | `游泳/潜水/浸泡导致的进水不在保修范围` | null | 22 |

2. **`products.detail_html`**（Pro）同样写明「耳机本体防护等级为 IPX5 … 充电仓本体不具备防水能力（IPX0）… 进液属人为损坏，不在保修范围」——即使走详情页也能得到同一结论。

3. **`aftersale_policies` 的 `warranty` 政策**（`id = 01J9Z8K2M4N5P6Q7R8S9T0P005`，`title = 维修与质保规则（非人为损坏）`）正文明确：
   - 「**人为损坏界定（不属免费质保）**：**进液 / 进水**：游泳、潜水、浸泡、淋浴、水流冲洗…导致电路板短路或电池仓损毁」；
   - 「因此『佩戴游泳后单耳无法开机』属典型进液人为损坏，**不在保修范围**」；
   - 兜底话术：超保人为损坏「按官方指导价 60% 换购同型号单品」。

4. **配套政策**：`return`（`P001`）列出「因人为误用、进水、摔落导致物理损毁的商品」不支持 7 天无理由；`freight`（`P004`）说明「因人为损坏（含进液/进水）发起的退换」运费由买家承担。

5. **可查询的售后单**：`AS20260922001`（`return_refund` / `WAIT_BUYER_RETURN` / 带 `return_address`）与 `AS20260917001`（`refund_only` / `PENDING_MERCHANT`）供 `query_aftersale` 使用。

> 结论：客服可同时依据「产品参数（IPX5 + 充电仓不防水 + 使用禁忌）」与「保修政策（进液不在保修范围）」回答「游泳进水不在保修范围」，并给出有偿换新兜底。

### 场景② 订单物流状态查询联动（「单号 DS20260920143000123 到哪了？」）

`orders.json` 中 `order_no = DS20260920143000123`（`created_at = 2026-09-20T06:30:00.000Z`，即 UTC+8 14:30）：

1. **主单**：`status = SHIPPED`（由子单聚合，`verify.mjs` 按 `docs/08` §8.3 规则校验）。
2. **两个子单**：`-01`（Pro ×2，`subtotal 25800`，`discount_alloc 1600`）与 `-02`（Lite ×1，`subtotal 9900`，`discount_alloc 400`），二者 `status = SHIPPED`。
3. **物流字段**（`express_company` / `express_company_code` / `express_no` / `shipped_at`）齐备：
   - `-01`：中通快递 / `ZTO` / `ZT9988776655` / `2026-09-20T09:00:00.000Z`
   - `-02`：顺丰速运 / `SF` / `SF1029384756` / `2026-09-20T09:30:00.000Z`
4. **`order_status_logs`**：该单共 **10 行** —— 4 行 `kind = status`（下单 → 支付 → 两个子单发货）与 **6 行 `kind = trace`** 物流轨迹（`remark` 即契约的 `desc`、`occurred_at` 即 `time`，按子单分组、时间递增）：
   - `-01`：`已揽收`(09-20T09:00Z) → `快件已到达【杭州转运中心】`(09-20T13:40Z) → `快件已到达【上海转运中心】，正在发往下一站`(09-21T02:10Z)
   - `-02`：`已揽收`(09-20T09:30Z) → `快件已到达【杭州中转场】`(09-20T15:20Z) → `快件已到达【上海转运中心】，正在发往下一站`(09-21T01:05Z)
5. **收件人**（脱敏前原文在 `orders.address_snapshot`，**绝不下发**）：李晓雨 / 13888888888 / 浙江省 杭州市 西湖区 —— 对应 `users.json` 的 `phone = 13888888888`，可验证 `/orders?phone=` 路径。
6. **`aftersaleSummary` 来源**：该单关联 `AS20260922001`（`WAIT_BUYER_RETURN`，属未终结状态）→ `hasAftersale = true`、`openCount = 1`。

> 与 PiEcho fixture 的对应：`PiEcho/tests/contract/fixtures/order.success.json` 的 `subOrderNo = DS20260920143000123-01`、`express.company = 中通快递`、`companyCode = ZTO`、`no = ZT9988776655`、`traces[0] = { time: 2026-09-20T09:00:00.000Z, desc: "已揽收" }`、`traces[1] = { time: 2026-09-21T02:10:00.000Z, desc: "快件已到达【上海转运中心】，正在发往下一站" }` —— **本数据集的轨迹逐字对齐这两个节点**。

### 场景③ 规则限制与负面防御（「支持心率监测吗？」→ 必须回答「不支持」）

**硬性要求**（`docs/08` §8.7 第 2 条）：参数集必须**完整**，否则无法区分「没这个功能」与「没录进来」。

1. **负面断言**：`product_attrs.json` 全表 **55 条**属性的 `group_name` / `attr_name` / `attr_value` **均不含「心率」**；`products.json` 的 `title` / `subtitle` / `detail_html` 与 `aftersale_policies.json` 的正文同样不含。`seed_cs.sql` 全文亦不含。
2. **参数集完整性**：Pro 覆盖 7 个分组共 30 条属性 —— `基本信息`(3) / `技术参数`(5) / `电池续航`(4) / `连接方式`(4) / `防护等级`(6) / `售后与保修`(3) / `包装清单`(5)；Lite 覆盖 7 个分组共 25 条。**可穿戴/健康监测类功能一条都没有**，因此 Agent 能据「参数已完整枚举且无此功能」回答「不支持心率监测」，而不是「查不到」。
3. `PiEcho` 侧断言「`attrGroups` 必须含 `防护等级`」在本数据集中对两个 SPU 均成立。

### 场景④ 剧烈情绪激化与人工兜底（`handover_to_human`）

- **无 DShop 数据依赖**（`docs/08` §8.7 表格：「无 DShop 数据」）。本数据集不为此场景提供额外表结构。
- 可间接支撑的旁证：`aftersale_policies` 五类政策（含 `freight` 的运费补贴上限 12 元、`warranty` 的 60% 有偿换新）与 `aftersales` 的 `timeline`（含 `actor_type = platform` 的客服介入行 `01J9Z8K2M4N5P6Q7R8S9T0G008`：「平台客服介入：已通知商家在 48 小时内处理，逾期自动同意」）——客服可据此说明平台已介入、给出确定性承诺后转人工。

---

## 4. 文档未定义项 —— 实现侧定案登记表

| # | 未定义项（来源） | 实现侧定案 |
| --- | --- | --- |
| 1 | Lite 音箱的 SKU 编码（`docs/M0-实施简报.md` §8 第 12 项） | `ASL-GN-ST`（军绿色/标准版）、`ASL-BK-ST`（曜石黑/标准版） |
| 2 | Lite 音箱的价格（同上） | `price = 9900` 分（99.00 元）、`market_price = 12900` 分（129.00 元）；两个 SKU 同价 |
| 3 | Lite 的 `spec_dimensions`（文档未给） | 颜色 `[军绿色, 曜石黑]`、版本 `[标准版]`（`orders.json` 中 Lite 项取「军绿色/标准版」，与 SKU 一致） |
| 4 | Lite 的库存（文档未给） | `ASL-GN-ST`：`stock 30 / locked_stock 0`；`ASL-BK-ST`：`stock 18 / locked_stock 0` |
| 5 | 3 个会员的具体手机号（§8 第 13 项，文档仅有脱敏示例） | `13912345678`（张伟 / `U1001`）、`13888888888`（李晓雨 / `U1002`）、`13712345678`（王浩然 / `U1003`）——均为合法 11 位号段，且 `138****8888` 与文档脱敏示例对齐 |
| 6 | 3 个会员的 ULID（`seed.md` 的 `U1001/U1002/U1003` 为 Mock 短 ID） | `01J9Z8K2M4N5P6Q7R8S9T0Z001` / `…Z002` / `…Z003`（26 位 Crocksford Base32） |
| 7 | 售后单号序列（文档只给格式与示例 `AS20260922001`） | `AS20260922001`（沿用文档示例）、`AS20260921001`、`AS20260917001`；当日序列号按申请先后取 `001` |
| 8 | 第 2、3 笔订单的主单号（`seed.md` §4.1 只给「`DS...`」） | `DS20260916142000001`（已签收）、`DS20260921103000456`（配货中，含 CANCELLED 子单） |
| 9 | 主单 `orders.id` 等非唯一键的 ULID | 统一前缀 `01J9Z8K2M4N5P6Q7R8S9T0` + 语义后缀（`W0xx` 订单 / `S0xx` 子单 / `J0xx` 商品项 / `E0xx` 状态日志 / `F0xx` 售后单 / `G0xx` 售后日志 / `K0xx` SKU / `A0xx`/`B0xx` 参数 / `P0xx` 政策 / `Z0xx` 会员 / `V1M1`/`V1R1`/`V1C1` 商户/门店/类目） |
| 10 | `users.phone` 的 AES-GCM 密文格式（契约只说「AES-GCM，密钥 `PHONE_ENC_KEY`」） | `seed_cs.sql` 写入开发占位 `enc:v1:devseed:<base64(明文)>`；**真实值由 `scripts/build-seed-sql.ts` 用 `PHONE_ENC_KEY` 现场派生**，不硬编码 |
| 11 | `phone_hash` 的 pepper 值（契约只说 `HMAC-SHA256(PHONE_HASH_PEPPER, 规范化11位)`） | `seed_cs.sql` 用开发用固定 pepper `dshop-dev-phone-hash-pepper` 现场计算；生产由 `PHONE_HASH_PEPPER` 派生 |
| 12 | `order_status_logs.kind` / `occurred_at` 列（契约 §5.5 标注为实现侧新增） | 本数据集按该定案写入：`kind ∈ {status, trace}`，`trace` 行 `remark` = 契约 `desc`、`occurred_at` = 契约 `time` |
| 13 | 退货收货地址（`aftersales.return_address`，文档未给） | `极光售后服务中心` / `057188880000` / 浙江省 杭州市 西湖区 三墩镇西园一路 8 号 DShop 杭州仓退货收货组（下发前经 `maskAgentPayload()` 脱敏） |
| 14 | `merchants` / `stores` 的具体名称与地址（文档只给 `shipFrom.storeName = "杭州仓"`） | 商户 `DShop 自营旗舰店`（`type = self`，`status = approved`，`commission_rate_bp = 0`）；仓库 `杭州仓`（`warehouse`）、门店 `杭州西湖自提店`（`store`，`supports_pickup = 1`） |
| 15 | 类目 ULID 与 `slug` | `01J9Z8K2M4N5P6Q7R8S9T0V1C1..C5`；`digital` / `headphone` / `tws-earbuds` / `speaker` / `portable-speaker` |
| 16 | `product_attrs` 分组名清单（PiEcho 硬断言只有 4 个） | 本数据集使用 7 个分组：`基本信息`、`技术参数`、`电池续航`、`连接方式`、`防护等级`、`售后与保修`、`包装清单`（后两个为文档明确要求，前四个含 PiEcho 断言必需项） |
| 17 | `aftersale_policies.version` 具体值（契约示例为 `"3"`，简报要求 `1.0.0`） | 统一 `1.0.0`（按简报 §7.1 要求；`policy.version` 是字符串，`"1.0.0"` 合法） |
| 18 | 订单 `channel` 取值分配（文档未指定哪单用哪个渠道） | `DS20260920143000123 = web`、`DS20260916142000001 = app`、`DS20260921103000456 = miniprogram` |
| 19 | `orders.remark` 是否允许写场景标注 | 允许（dev 数据）；三笔分别标注所属 Golden 场景，便于排查。**生产不得导入** |
| 20 | `merchants.settlement_account` / `stores.business_hours` 的 JSON 结构 | 自定义：`{"bank","account","holder"}` / `{"weekdays","weekend"}` |

---

## 5. 如何加载

```bash
# 1) 建表（41 表迁移，含二期表）
npm run db:migrate:local

# 2) 导入 seed-cs（幂等，可重复执行）
npm run seed:cs:local
```

`seed:cs:local` 实际执行：
`wrangler d1 execute dshop-db-dev --local --config apps/api/wrangler.jsonc --file=data/seed-cs/seed_cs.sql`

自检（零依赖，无需 `npm install`）：

```bash
node data/seed-cs/verify.mjs
# 期望输出结尾：== 结果：50 通过 / 0 失败 == / ALL GREEN
```

staging（**需 Q8 已定案的独立令牌与授权**）：

```bash
npm run db:migrate:staging
npm run seed:cs:staging
```

---

## 6. `users.json` 中 `phone` / `phone_hash` 的说明（**重要**）

- `users.phone` 是**加密存储**（AES-GCM，密钥 `PHONE_ENC_KEY`）；`users.phone_hash` 是 `HMAC-SHA256(PHONE_HASH_PEPPER, 规范化 11 位手机号)`，供 `/orders?phone=` 等值比对（`docs/M0-字段契约.md` §1.1）。
- 因此 **`users.json` 只提供明文手机号作为来源**，其中的 `phone_hash` 字段是**占位字符串**（`placeholder:hmac-sha256(...)`），**不是可用的哈希值**，不得直接用于比对。
- 真正的 `phone`（密文）与 `phone_hash` 由 **`scripts/build-seed-sql.ts`** 用运行环境密钥**现场派生**：
  `phone = AES-GCM(PHONE_ENC_KEY, 明文)`、`phone_hash = HMAC-SHA256(PHONE_HASH_PEPPER, 明文)`。
- 本目录的 `seed_cs.sql` 为了「可脱离密钥直接导入本地 D1」而写入**开发用确定性占位值**：
  `phone = enc:v1:devseed:<base64(明文)>`、`phone_hash = HMAC-SHA256("dshop-dev-phone-hash-pepper", 明文)`。
  该 pepper 仅存在于 dev 种子，**与生产密钥无关**。
- 手机号在日志与响应中一律**不落明文**；Agent 响应中经 `maskAgentPayload()` 脱敏为 `138****8888`。

---

## 7. 生成与校验

- 本目录 JSON 是**唯一手写来源**；`seed_cs.sql` 由 `scripts/build-seed-sql.ts` 生成（本次交付用等价的临时生成器产出，规则一致：JSON 列序列化为 SQL 字符串字面量、单引号转义为 `''`、`ON CONFLICT(<唯一键>) DO UPDATE SET`）。
- 冲突键（`docs/M0-字段契约.md` §12）：`merchants.id`、`stores.id`、`categories.id`、`products.id`、`product_skus.sku_code`、`product_attrs.id`、`product_images.id`、`orders.order_no`、`sub_orders.sub_order_no`、`order_items.id`、`order_status_logs.id`、`aftersales.aftersale_no`、`aftersale_logs.id`、`aftersale_policies.id`、`users.phone_hash`。
- `verify.mjs` 覆盖 50 项断言：单号正则、UTC+8⇔UTC 一致性、枚举取值、主单状态聚合规则、场景①③支撑、SQL 幂等与冲突键、引号配平、负面断言（全库无「心率」）。
