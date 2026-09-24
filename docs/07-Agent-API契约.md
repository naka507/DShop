# DShop 架构设计 · 第 7 部分

> **内容**：§7 供 PiEcho 的 Agent API 契约（§7.1–§7.13）：六端点定义、鉴权脱敏只读限流、契约版本化、离线同步、SLO、受控写预案、演进路线
> **导航**：[文档总目录](README.md) ｜ 上一部分：[06-API路由命名空间](06-API路由命名空间.md) ｜ 下一部分：[08-核心业务流程](08-核心业务流程.md)

---

## 7. ★ 供 PiEcho 的 Agent API 契约

> 本章是 DShop ↔ PiEcho 的**唯一正式接口契约**，也是**本项目存在的理由**（§1.1 角色 A）。机器可读定义位于 `packages/shared/src/contracts/agent/`（Zod Schema），CI 生成 `docs/agent-api.openapi.json` 供 PiEcho 侧代码生成。**文档与 Schema 不一致时以 Schema 为准。**
>
> **契约纪律（P2）**：本章任何字段的变更都直接影响 PiEcho 的答话能力与测试用例。破坏性变更需 ≥90 天双版本并行（§7.9），且必须在 M0 之后的所有里程碑中持续满足——**商城功能的开发不得成为改契约的理由**。

### 7.1 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | `https://api.dshop.example.com/api/v1/agent` |
| 方法 | **默认仅 GET**（§7.8.3）；受控写为独立开关（§7.12） |
| 请求头 | `X-Service-Token`（必填）、`X-Contract-Version`（**建议携带，缺失按 `1` 处理并记录告警日志**，见 §7.9）、`X-Request-Id`（建议，全链路追踪） |
| 响应体 | `{ code, message, data }`，`code=0` 成功 |
| 编码 | UTF-8，`Content-Type: application/json; charset=utf-8` |
| 时间 / 金额 | 时间 ISO-8601 UTC；金额**一律为整数分**（`12900` = ¥129.00），**不使用浮点**。**JSON 响应字段用 camelCase**（如 `payAmount` / `refundAmount` / `totalAmount` / `unitPrice`）；**D1 列名用 snake_case**（如 `pay_amount` / `refund_amount`，§5）。两组命名不得混用，响应字段名以 §7 各端点示例与 Zod Schema 为准 |
| 缓存 | 响应带 `Cache-Control` 与 `X-Cache: HIT\|MISS`，逐端点见下 |

**统一错误码表**（Agent 组）：

| code | HTTP | 含义 | PiEcho 侧建议动作 |
| --- | --- | --- | --- |
| `0` | 200 | 成功 | — |
| `40001` | 400 | 参数校验失败（缺参/类型错/越界） | 修正参数，不重试 |
| `40010` | 400 | **显式提供了**不受支持的 `X-Contract-Version`（缺失不报此错） | 告警，按支持版本重发 |
| `40101` | 401 | 服务令牌缺失或无效 | 告警，人工介入 |
| `40102` | 401 | 服务令牌已吊销/已过期 | 告警，人工轮换令牌 |
| `40301` | 403 | 令牌 scope 不含该资源 | 修正 scope，不重试 |
| `40401` | 404 | 订单不存在 | 转"未找到该订单"话术，不重试 |
| `40402` | 404 | 商品不存在或已删除 | 转"该商品已下架"话术 |
| `40403` | 404 | 售后单不存在 | 转"未找到该售后单"话术 |
| `40404` | 404 | **政策分类无生效条款**（`category` 合法但该分类下无 `status=effective` 的条款） | 转"暂无该分类的售后政策"话术，**不得**答成商品下架 |
| `40501` | 405 | 对 Agent 组使用了非 GET 方法（且受控写未启用） | 代码缺陷，修正调用方式 |
| `40901` | 409 | 受控写幂等冲突或状态不允许（§7.12 启用后） | 读取当前状态后决定是否重试 |
| `42901` | 429 | 触发限流 | 读 `Retry-After` 后延迟重试 |
| `50001` | 500 | 服务内部错误 | 可重试 1 次 |

### 7.2 `GET /api/v1/agent/orders/{orderNo}` — 订单主单 + 子单 + 物流状态

**用途**：客服回答"我的订单到哪了""为什么只发了一件""钱付了吗""什么时候发的货"。

**对应 `seed.md` 场景**：场景一（进水退货，需读订单与商品规格）、场景二（查物流）。

**路径参数**：`orderNo`（string，**必填**，主单号）。**格式规则（PiEcho 侧可据此做正则校验）**：`DS` + 17 位数字，**总长 19**，正则 `^DS\d{17}$`；17 位 = **14 位秒级时间戳 `YYYYMMDDHHmmss`（Asia/Shanghai，UTC+8）+ 3 位当秒序列**（同秒内自增，`001`–`999`，如 `DS` + `20260920143000` + `123` = `DS20260920143000123`）。子单号为 `{orderNo}-{2 位序号}`（如 `DS20260920143000123-01`）。格式非法按 `40001` 返回，不落库查询。**⚠️ 时区口径**：单号内嵌时间戳为 **Asia/Shanghai（UTC+8）**，与 §5.1 的时间字段（ISO-8601 **UTC**，`...Z`）不同口径——例如 `DS20260920143000123` 对应 `createdAt = 2026-09-20T06:30:00.000Z`。解析单号时间戳时**不要**当作 UTC。

**查询参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `includeItems` | boolean | 否 | `true` | 是否返回 `order_items` 商品快照（客服问"买的什么"时为 true） |
| `includeAftersales` | boolean | 否 | `false` | 是否附带该主单下全部售后单摘要 |

**响应示例**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "orderNo": "DS20260920143000123", "status": "SHIPPED", "statusText": "已发货", "channel": "web",
    "createdAt": "2026-09-20T06:30:00.000Z", "paidAt": "2026-09-20T06:31:22.000Z", "payDeadline": "2026-09-20T06:45:00.000Z",
    "totalAmount": 25800, "discountAmount": 2000, "freightAmount": 0, "payAmount": 23800, "currency": "CNY",
    "receiver": { "name": "张**", "phone": "138****8888", "region": "浙江省 杭州市 西湖区", "addressMasked": "浙江省 杭州市 西湖区 ***" },
    "subOrders": [
      { "subOrderNo": "DS20260920143000123-01", "merchantName": "DShop 自营旗舰店", "merchantType": "self",
        "status": "SHIPPED", "statusText": "已发货", "subtotal": 25800, "discountAlloc": 2000, "freight": 0, "payableAmount": 23800,
        "shipFrom": { "storeName": "杭州仓", "city": "杭州市" },
        "express": { "company": "中通快递", "companyCode": "ZTO", "no": "ZT9988776655", "shippedAt": "2026-09-20T09:00:00.000Z",
          "latestStatus": "运输中", "latestStatusAt": "2026-09-21T02:10:00.000Z",
          "traces": [ { "time": "2026-09-20T09:00:00.000Z", "desc": "已揽收" }, { "time": "2026-09-21T02:10:00.000Z", "desc": "快件已到达【上海转运中心】，正在发往下一站" } ] },
        "items": [ { "skuId": "01J9Z8K2M4SKU0001", "title": "极光 Pro 真无线降噪耳机", "spec": { "颜色": "曜石黑", "版本": "降噪版" },
                    "imageUrl": "https://img.dshop.example.com/p/xxx.jpg", "unitPrice": 12900, "quantity": 2, "subtotal": 25800 } ],
        "aftersales": [ { "aftersaleNo": "AS20260922001", "type": "return_refund", "status": "PENDING_MERCHANT", "refundAmount": 12900 } ] }
    ],
    "aftersaleSummary": { "hasAftersale": true, "openCount": 1, "refundedAmount": 0 }
  }
}
```

**状态枚举**：主单 `PENDING_PAYMENT` 待支付 / `PAID` 已支付 / `SHIPPED` 已发货 / `COMPLETED` 已完成 / `CANCELLED` 已取消；子单 `PAID` 待发货 / `SHIPPED` 已发货 / `COMPLETED` 已完成 / `CANCELLED` 已取消。`express.latestStatus` 为渠道原始文本，`traces` 最多返回最近 **10** 条。

> **⚠️ 与 `seed.md` 的状态名映射（M0 必须落实）**：`seed.md` §4.1 的 Mock 订单用了 `DELIVERED`（已签收）、`SHIPPED`（在途运输中）、`PENDING_DISPATCH`（仓库配货中）三个状态名，与本契约枚举**不是同一套**。落地规则：`PENDING_DISPATCH` → 子单 `PAID`（statusText「待发货」/「仓库配货中」）；`SHIPPED` → 子单 `SHIPPED`；`DELIVERED` → 子单 `COMPLETED`（已签收，`statusText` 保留「已签收」）。**`seed-cs` 数据集与 fixture 一律使用本契约枚举**，`statusText` 可保留业务语义文案供客服引用。

**错误码**：`40001`（`orderNo` 缺失或格式非法）、`40401`、`40101/40102/40301`、`42901`。

**幂等 / 缓存**：GET 幂等；**不缓存**（`Cache-Control: no-store`）——订单状态变化频繁，客服场景要求强实时。物流轨迹由 Cron 每小时拉取在途单落库，非实时直连快递商，`express.latestStatusAt` 表明数据新鲜度。

**鉴权 / 限流**：scope `agent:order:read`；**120 次/分钟/令牌**，burst 20。

### 7.3 `GET /api/v1/agent/orders` — 用户最近订单列表

**用途**：用户只报手机号或会员 ID 时先定位订单——"请问是哪一笔订单？您最近有 3 笔订单"。

**查询参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `userId` | string | 二选一 | — | DShop 会员 ID（ULID） |
| `phone` | string | 二选一 | — | 会员手机号（11 位），服务端规范化后 HMAC 比对，不落明文日志 |
| `status` | string | 否 | — | 按主单状态过滤，多值逗号分隔 |
| `limit` | integer | 否 | `5` | 1–20 |
| `cursor` | string | 否 | — | 游标分页，取自上次响应的 `nextCursor` |

**响应示例**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "userId": "01J9Z8K2M4ABCDEFGHJKMNPQRS",
    "list": [
      { "orderNo": "DS20260920143000123", "status": "SHIPPED", "statusText": "已发货", "payAmount": 23800,
        "itemSummary": "极光 Pro 真无线降噪耳机 等 1 件商品", "itemCount": 1, "createdAt": "2026-09-20T06:30:00.000Z",
        "subOrderCount": 1, "allShipped": true, "hasOpenAftersale": true }
    ],
    "nextCursor": "eyJ0IjoxNzU4MzQ1MDAwMDAwLCJpZCI6IjAxSjlac...", "hasMore": false
  }
}
```

**错误码**：`40001`（`userId` 与 `phone` 同时缺失或同时提供）、`40401`、`40101/40102/40301`、`42901`。

**幂等 / 缓存**：GET 幂等；**10s 边缘缓存**（Cache API，key = `agent:orders:{userId}:{status}:{limit}:{cursor}`），响应带 `X-Cache`——同一会话内连续追问可命中，降低 D1 读量。

**鉴权 / 限流**：scope `agent:order:read`；**120 次/分钟/令牌**。

**隐私**：`phone` 查询参数**不写入访问日志**（`accessLog` 对 Agent 组的 `phone`/`token` 参数脱敏）；响应体不含手机号明文。

### 7.4 `GET /api/v1/agent/products/{spuId}/specs` — 商品规格 / 参数白皮书

**用途**：客服回答"支持无线充电吗""保修几年""尺寸多大"等**参数类问题**。这也是 PiEcho 侧**最适合同步进本地向量库**的接口（§7.10）。

**对应 `seed.md` 场景**：场景一（IPX5 防水边界）、场景三（防幻觉：心率监测不存在）。

**路径参数**：`spuId`（string，**必填**，商品 SPU ID，ULID）

**查询参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `includeSkus` | boolean | 否 | `true` | 是否返回 SKU 规格矩阵与价格 |
| `attrGroup` | string | 否 | — | 只返回指定参数分组（如 `保修`） |
| `ifNoneMatch` | string | 否 | — | 传上次响应的 `data.contentHash`，未变更返回 `304`（空 body） |

**响应示例**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "spuId": "01J9Z8K2M4ABCDEFGHJKMNPQRS", "title": "极光 Pro 真无线降噪耳机", "subtitle": "45dB 深度降噪 · 综合续航 36 小时",
    "brand": "极光", "categoryPath": ["数码", "耳机", "真无线耳机"], "status": "onsale",
    "mainImage": "https://img.dshop.example.com/p/xxx.jpg",
    "updatedAt": "2026-09-18T03:00:00.000Z", "contentHash": "sha256:9f2c1a...",
    "attrGroups": [
      { "groupName": "基本信息", "attrs": [ { "name": "型号", "value": "Aurora-Buds-Pro", "unit": null },
        { "name": "佩戴方式", "value": "真无线入耳式", "unit": null },
        { "name": "驱动单元", "value": "11mm 动圈 + 复合陶瓷高音动铁双单元", "unit": null } ] },
      { "groupName": "技术参数", "attrs": [ { "name": "降噪深度", "value": "45", "unit": "dB" },
        { "name": "蓝牙版本", "value": "5.4", "unit": null }, { "name": "单次续航", "value": "8", "unit": "小时" },
        { "name": "综合续航（含充电仓）", "value": "36", "unit": "小时" } ] },
      { "groupName": "售后与保修", "attrs": [ { "name": "质保期", "value": "12", "unit": "个月" },
        { "name": "保修范围", "value": "非人为损坏", "unit": null }, { "name": "是否支持 7 天无理由", "value": "支持", "unit": null } ] },
      { "groupName": "防护等级", "attrs": [ { "name": "防水等级", "value": "IPX5", "unit": null },
        { "name": "使用禁忌", "value": "不可游泳、淋浴、浸泡；充电仓不防水", "unit": null } ] }
    ],
    "specDimensions": [ { "name": "颜色", "values": ["曜石黑", "冰晶白"] }, { "name": "版本", "values": ["标准版", "降噪版"] } ],
    "skus": [ { "skuId": "01J9Z8K2M4SKU0001", "skuCode": "ABP-BK-NC", "spec": { "颜色": "曜石黑", "版本": "降噪版" },
                "price": 12900, "marketPrice": 15900, "status": "active", "inStock": true } ]
  }
}
```

> **对 PiEcho 的关键意义**：`attrGroups` 是**商品事实的唯一权威来源**。`seed.md` 场景一（游泳进水）与场景三（心率监测）都要求 Agent **基于检索到的事实回答，不得编造**。因此本端点必须把「防水等级」「使用禁忌」这类**边界与禁忌信息**作为一等参数下发（如上例的 `防护等级` 分组），而不是只给营销性参数——否则 PiEcho 的防幻觉场景（场景三）缺少判据，Golden 测试必然失败。

**错误码**：`40001`、`40402`、`40101/40102/40301`、`42901`。

**幂等 / 缓存**：GET 幂等；**5 分钟边缘缓存**；支持 `contentHash` + `ifNoneMatch` 条件请求返回 `304`，便于 PiEcho 增量同步向量库；后台商品写操作主动失效缓存。

**鉴权 / 限流**：scope `agent:product:read`；**300 次/分钟/令牌**（读多、可缓存）。

**脱敏**：仅返回面向 C 端已公开的商品信息；**不下发** `cost_price`、供应商、采购价、内部备注。

### 7.5 `GET /api/v1/agent/products/{spuId}/stock` — 库存与发货地

**用途**：客服回答"还有货吗""什么时候能发""从哪发货"。

**路径参数**：`spuId`（string，**必填**，ULID）

**查询参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `skuId` | string | 否 | — | 只看单个 SKU |
| `quantity` | integer | 否 | `1` | 判断是否满足该数量，返回 `available` 布尔 |
| `regionCode` | string | 否 | — | 收货地区码（预留：多仓就近判断） |

**响应示例**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "spuId": "01J9Z8K2M4ABCDEFGHJKMNPQRS", "status": "onsale", "checkQuantity": 1, "available": true,
    "totalStock": 42, "updatedAt": "2026-09-21T02:00:00.000Z",
    "shipFrom": [ { "storeId": "01J9Z8STORE0001", "storeName": "杭州仓", "type": "warehouse",
                    "city": "杭州市", "province": "浙江省", "supportsPickup": false } ],
    "skus": [
      { "skuId": "01J9Z8K2M4SKU0001", "skuCode": "ABP-BK-NC", "spec": { "颜色": "曜石黑", "版本": "降噪版" },
        "stock": 42, "inStock": true, "restockEta": null },
      { "skuId": "01J9Z8K2M4SKU0002", "skuCode": "ABP-WH-NC", "spec": { "颜色": "冰晶白", "版本": "降噪版" },
        "stock": 0, "inStock": false, "restockEta": "2026-09-28" }
    ]
  }
}
```

**字段说明**：`stock` 为**可售库存** = `product_skus.stock - product_skus.locked_stock`（已锁定的不对外宣称可售，与 §5.3 ② 的下单只锁定口径一致）；`available` = 目标数量 ≤ 可售库存，客服话术应优先依据 `available`；`restockEta` 取自 `product_attrs` 中 `attr_name='预计到货'`，无则 `null`。库存为**异步快照**，不承诺与实际扣减瞬时一致。

**错误码**：`40001`、`40402`、`40101/40102/40301`、`42901`。

**幂等 / 缓存**：GET 幂等；**30s 边缘缓存**——库存是高频问询点，必须缓存以防单商品打爆 D1；话术须含"库存实时变动，以提交订单时为准"的兜底。

**鉴权 / 限流**：scope `agent:product:read`；**300 次/分钟/令牌**。

### 7.6 `GET /api/v1/agent/aftersales/{aftersaleNo}` — 售后单状态

**用途**：客服回答"退款到哪一步了""什么时候到账""需要我寄回吗"。

**对应 `seed.md` 场景**：场景一（进水后的替代方案：有偿折扣换新）。

**路径参数**：`aftersaleNo`（string，**必填**）。**格式规则**：`AS` + 11 位数字（`YYYYMMDD` + 3 位当日序列），**总长 13**，正则 `^AS\d{11}$`（如 `AS` + `20260922` + `001` = `AS20260922001`）；格式非法按 `40001` 返回。

**查询参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `includeTimeline` | boolean | 否 | `true` | 是否返回 `aftersale_logs` 时间线 |
| `includePolicy` | boolean | 否 | `false` | 是否附带命中的售后政策摘要（免二次调用 `/policies`） |

**响应示例**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "aftersaleNo": "AS20260922001", "type": "return_refund", "typeText": "退货退款",
    "status": "WAIT_BUYER_RETURN", "statusText": "待买家回寄",
    "orderNo": "DS20260920143000123", "subOrderNo": "DS20260920143000123-01", "skuId": "01J9Z8K2M4SKU0001",
    "itemTitle": "极光 Pro 真无线降噪耳机", "quantity": 1, "refundAmount": 12900, "currency": "CNY",
    "reason": "商品与描述不符", "evidenceCount": 2,
    "createdAt": "2026-09-22T01:00:00.000Z", "deadlineAt": "2026-09-29T01:00:00.000Z",
    "returnAddress": { "name": "张**", "phone": "0571****0000", "region": "浙江省 杭州市 西湖区", "addressMasked": "浙江省 杭州市 西湖区 ***" },
    "returnExpress": null,
    "refund": { "status": "PENDING", "refundNo": null, "channel": null, "arrivedAt": null, "estimatedArrivalDays": 3 },
    "timeline": [
      { "at": "2026-09-22T01:00:00.000Z", "actor": "buyer", "from": null, "to": "PENDING_MERCHANT", "remark": "用户提交退货退款申请" },
      { "at": "2026-09-22T03:20:00.000Z", "actor": "merchant", "from": "PENDING_MERCHANT", "to": "WAIT_BUYER_RETURN", "remark": "商家同意，已提供退货地址" }
    ],
    "policy": { "category": "return", "title": "7 天无理由退货规则", "version": "3", "summary": "签收后 7 日内且不影响二次销售可申请…" }
  }
}
```

**状态枚举**：`PENDING_MERCHANT` 待商家处理 / `WAIT_BUYER_RETURN` 待买家回寄 / `BUYER_RETURNED` 买家已回寄 / `MERCHANT_RECEIVED` 商家已收货 / `REFUNDING` 退款处理中 / `REFUNDED` 已退款 / `REJECTED` 已驳回 / `CANCELLED` 用户撤销。

**错误码**：`40001`、`40403`、`40101/40102/40301`、`42901`。

**幂等 / 缓存**：GET 幂等；**不缓存**（`no-store`）——退款进度是强时效性客服问题。

**鉴权 / 限流**：scope `agent:aftersale:read`；**120 次/分钟/令牌**。

**脱敏**：退货地址按 §7.8.2 脱敏；`evidence_urls` **不下发**（凭证图可能含隐私），仅返回 `evidenceCount`。

### 7.7 `GET /api/v1/agent/policies/{category}` — 售后政策条款

**用途**：给客服提供**可引用的话术依据**（退货规则、运费承担、时效、特殊品类例外）。可选：PiEcho 侧定期拉取写入本地向量库，作为 RAG 的权威语料。

**对应 `seed.md` 场景**：场景一（运费归属、人为损坏界定）、场景四（转人工规则）。

**路径参数**：`category`（string，**必填**，枚举 `return` 退货 / `refund` 退款 / `exchange` 换货 / `freight` 运费 / `warranty` 保修 / `all` 全部）

**查询参数**

| 名称 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `version` | string | 否 | 最新生效版 | 指定版本号 |
| `format` | string | 否 | `markdown` | `markdown` \| `plain` |
| `ifNoneMatch` | string | 否 | — | 传上次 `data.contentHash`，未变更返回 `304` |

**响应示例**

```json
{
  "code": 0, "message": "ok",
  "data": {
    "category": "return", "contentHash": "sha256:3ab7f0...",
    "items": [
      { "policyId": "01J9Z8POLICY0001", "title": "7 天无理由退货规则", "version": "3",
        "effectiveFrom": "2026-06-01T00:00:00.000Z", "effectiveTo": null, "updatedAt": "2026-08-15T02:00:00.000Z",
        "content": "## 适用范围\n\n自签收之日起 7 个自然日内，商品不影响二次销售的前提下…", "tags": ["无理由", "时效"] }
    ]
  }
}
```

**错误码**：`40001`（`category` 非法枚举）、**`40404`（该分类无生效条款）**、`40101/40102/40301`、`42901`。

**幂等 / 缓存**：GET 幂等；**1 小时边缘缓存**；支持 `contentHash` 条件请求。政策更新走后台发布流程，发布时主动失效缓存。

**鉴权 / 限流**：scope `agent:policy:read`；**60 次/分钟/令牌**（低频、可长缓存）。

**政策发布流程（M0 交付）**：平台后台 `POST /api/v1/admin/aftersale-policies` 发布/更新政策，权限点 `aftersale:policy:manage`，落 `audit_logs`，发布后主动失效 `/policies/*` 的边缘缓存。**这是 PiEcho 政策语料的唯一维护入口**——政策变更不需要改代码或重新部署，也不需要通知 PiEcho 改配置（PiEcho 按 `contentHash` 自动感知，§7.10）。

### 7.8 鉴权、脱敏、只读保证、限流

#### 7.8.1 服务令牌（Service Token）

| 项 | 约定 |
| --- | --- |
| 格式 | `dshop_svc_<24 位随机 base62>_<6 位校验位>`；**仅创建时明文返回一次** |
| 传输 | Header `X-Service-Token: dshop_svc_...`（**不允许**放在 query string） |
| 存储 | `service_tokens.token_hash` = `HMAC-SHA256(AGENT_TOKEN_PEPPER, token)`；`token_prefix` 存前 16 位便于识别与轮换 |
| 绑定信息 | `scopes`（`agent:order:read` / `agent:product:read` / `agent:aftersale:read` / `agent:policy:read`）、`rate_limit_per_min`、`expires_at`、`status` |
| 签发 | 后台 `POST /api/v1/admin/agent-tokens`，需权限点 `agent:token:manage`，**强制 TOTP 二次确认 + 落审计** |
| 轮换 | 支持**双令牌并行**（旧令牌设 `expires_at` 宽限期 7 天），零停机；`POST /admin/agent-tokens/:id/revoke` 立即吊销 |
| 有效期 | 默认 180 天，到期前 30 天 Cron 告警 |
| 与用户体系隔离 | 服务令牌**不是 JWT**、不含 `aud`，**不能访问任何非 `/agent` 路由**；反向亦成立：任何用户 JWT 访问 `/agent/*` 一律 `401` |
| 可选加固 | 若启用，须使用**独立于令牌的签名密钥** `AGENT_SIGN_SECRET`（与令牌分别保管、独立轮换）；待签串 `HMAC-SHA256(AGENT_SIGN_SECRET, timestamp + method + path + query)`，请求头 `X-Timestamp` + `X-Signature`；服务器时间偏离 > 300s 拒绝。开关 `settings.agent_require_signature`，默认关闭 |

**令牌交付流程（M0 必须走通，是 PiEcho 联调的前置条件）**：

1. 平台超管在后台签发令牌，四个 scope 全选（PiEcho 需要全部四个）。
2. **明文令牌只显示一次**——通过安全渠道交付 PiEcho 负责人，写入 PiEcho 的 `ESHOP_SERVICE_TOKEN` Secret。
3. 记录 `token_prefix` 与到期日，建立轮换日历（到期前 30 天告警）。
4. 轮换演练：签发新令牌 → PiEcho 双令牌配置 → 观察 `agent_call_logs` 中 `token_id` 分布 → 确认旧令牌零调用 → 吊销旧令牌。**此演练须在 M1 完成一次**，不能等到生产。

#### 7.8.2 字段脱敏规则（强制，实现于 `packages/services/mask.ts`）

| 字段 | 规则 | 示例 |
| --- | --- | --- |
| 手机号（收件人/会员） | 保留前 3 后 4 | `138****8888` |
| 固定电话 | 保留区号 | `0571****0000` |
| 收件人/联系人姓名 | 仅保留姓氏 + `**` | `张**` |
| 收货地址 | 仅下发省/市/区 + `***`，**详细地址与门牌号不下发** | `浙江省 杭州市 西湖区 ***` |
| 退货地址 | 同上（客服需完整地址时走人工流程，不由 Agent 提供） | — |
| 快递员电话 | 不下发 | — |
| 物流单号 / 订单号 / 售后单号 | **完整下发**（客服必需） | `SF1234567890123` |
| 用户 ID | 完整下发（内部 ULID，非敏感标识） | `01J9Z8...` |
| **绝不下发** | `password_hash`、`wechat_openid`/`unionid`、`raw_callback`、支付渠道密钥、`cost_price`、供应商信息、`address_snapshot` 原文、售后凭证图 URL、后台账号信息 | — |

**实现约束**：Agent 组**所有响应必须经过 `maskAgentPayload()` 单一出口函数**；该函数以 Zod Schema 的 `.strip()` 模式运行——**白名单外字段一律丢弃**，而非黑名单式删除。这是防止「新增字段意外泄露」的结构性保证（P3）。

**为什么白名单而非黑名单**：商城功能会持续新增字段（如后续加「用户备注」「内部标签」）。黑名单需要每次新增字段都记得补一条规则，漏一次就是数据泄露；白名单下新字段默认**不下发**，漏了只是功能缺失，可被发现并修复。安全默认值必须是「不发」。

#### 7.8.3 只读保证（四重）

| 层 | 机制 |
| --- | --- |
| ① HTTP 方法白名单 | Agent 路由组注册时**只挂 `GET`**；中间件 `agentReadOnlyGuard` 对 `POST/PUT/PATCH/DELETE` 一律返回 `405` + `code: 40501`。**默认不存在任何写端点** |
| ② 数据库访问面收窄 | Agent 组**禁止 import 写操作**：只能用 `packages/db/readonly` 导出的查询构造器（仅暴露 `select`/`query` builder），不导出 `insert/update/delete`；CI 用 ESLint `no-restricted-imports` 对 `apps/api/src/routes/agent/**` 与 `packages/services/agent/**` 禁用写 API 与 `DB.batch` |
| ③ 无副作用路径 | Agent 组不注册任何 TaskQueue 任务、不写业务表；唯一写入是 `agent_call_logs`（审计），走独立异步路径，失败不影响响应 |
| ④ 部署级隔离 | 量级上来后拆独立 Worker + 只读副本（S10/S11，触发阈值见 §4.3）。**D1 无独立数据库账号概念**，故第 ④ 层是「用副本/独立部署代替只读账号」的等价方案 |

明确说明：Cloudflare D1 不提供「只读数据库账号」。因此 DShop 以「**方法白名单 + 代码层访问面收窄 + CI 静态约束 + 副本隔离**」四重组合实现只读保证，且四重都可被审计（②④ 有 CI 与配置证据）。

**与 §7.12 受控写的关系**：若 Q5 决策为「开放受控写」，则第 ①② 层需按 §7.12 的方式放宽——**只对白名单内的写端点放开，其余仍为 405**，且写路径必须走独立中间件链与独立权限点。四重保证的其余两层（③④）不变。

#### 7.8.4 限流与超时

| 维度 | 默认配额 | 说明 |
| --- | --- | --- |
| 令牌全局 | `rate_limit_per_min`（默认 **600** 次/分钟） | **本版调整：Agent 组默认启用 Durable Object 全局精确计数**（绑定 `AGENT_RL`，§4.2）。固定窗口计数不逐请求写 KV、不消耗 D1 写。**Cache API 作为降级路径**（DO 不可用时回退，此时退化为 per-colo 近似配额，约 `600×N`，并记录告警） |
| 单端点 | 见各端点「鉴权/限流」行 | 端点级配额更严，防止单点打爆 |
| 突发 | burst 20（令牌桶） | 应用层实现：同窗口计数器（DO / Cache API）判定 + 隔离实例本地内存平滑，**不写 KV** |
| 超限响应 | `429` + `code: 42901` + `Retry-After: <秒>` | PiEcho 必须遵守 `Retry-After` |
| 服务端超时 | handler 硬上限 **3s** | 超时返回 `50001`；D1 查询常态 < 50ms |
| 客户端建议 | 连接 3s / 读 5s 超时 | 仅 GET 可重试 1 次（退避 200ms） |
| 熔断建议 | PiEcho 侧按令牌维度做失败率熔断 | 连续 5xx 超阈值时降级为「请稍后再试」话术 |
| 可观测 | `agent_call_logs` 记录 `duration_ms`、`cache_hit`、`status` | Cron 每分钟批量落库；后台提供配额看板 |

**为什么本版把 DO 计数从「生产建议」改为「默认启用」**：上一稿的 600/min 是 **per-colo 近似配额**——同一令牌在 N 个 colo 上各可跑满，实际放行量约 `600×N`，且计数可能随缓存淘汰丢失。对商城自身的用户流量而言这是可接受的近似；但对 PiEcho 而言，**限流行为不可预测等于联调与压测不可复现**：PiEcho 无法确定自己的客户端令牌桶该设多少，压测结果也无法归因。全局精确配额是 P4（可用性前置）的一部分。

**配额调整流程**：PiEcho 若需更高配额（如会话量增长），由 DShop 侧在后台调整该令牌的 `rate_limit_per_min` 与端点级配额，**无需改代码、无需重新部署**，调整即时生效并落 `audit_logs`。端点级配额在 `settings` 表按令牌可覆盖。

### 7.9 契约版本化与变更流程

| 项 | 约定 |
| --- | --- |
| 版本载体 | Header `X-Contract-Version: 1`（**建议携带**，非必填）。**缺失时视为 `1` 并记录告警日志**（对消费方宽容，不返回错误） |
| 路径版本 | `/api/v1/` 固定；**破坏性变更才升 `X-Contract-Version`**（字段删除、类型变更、枚举值移除、必填化、语义变更） |
| 非破坏性变更 | 新增可选响应字段、新增端点、新增枚举值、放宽校验 —— **不升版本**，直接上线 |
| 并行支持 | 升到 `2` 时同时支持 `1` 与 `2` **至少 90 天**，按 Header 分流到不同 Zod Schema 与序列化器 |
| 不支持版本 | 显式提供了不受支持的版本号时，返回 `400` + `code: 40010`（缺失不触发该错误，按 `1` 处理并告警） |
| 弃用公告 | 响应头 `Deprecation: true` + `Sunset: <HTTP-date>`，同时通过运维渠道通知 PiEcho |

**变更流程（DShop 侧，硬性）**：

```
1. 改契约 Schema：packages/shared/src/contracts/agent/*.ts（Zod）
2. CI 生成 docs/agent-api.openapi.json + 契约快照（breaking-change 检测）
3. 若为破坏性变更 → 升 X-Contract-Version，保留旧版本 handler
4. 契约测试：Vitest 跑契约快照；Playwright 跑 Agent 契约 E2E
5. 部署 staging → 通知 PiEcho 联调（PiEcho 用生成客户端，类型错误即暴露不兼容）
6. 部署 production → 观察 agent_call_logs 中 contract_version 分布
7. 旧版本调用量归零且满 90 天后，下线旧版本 handler
```

**关键约定**：**契约 Schema 是唯一真相**。任何绕过 `packages/shared/src/contracts/agent/` 直接在路由里手写响应的做法，一律 code review 拒绝。

**发布门禁（本版加强，P2）**：Agent 契约快照测试与 Agent 契约 E2E 是**所有环境部署的硬门禁**，与商城功能的测试同等地位——**商城功能测试通过但契约测试失败，一律不允许部署**。理由：商城发布破坏 Agent 契约，等于让 PiEcho 线上故障，而这类故障在 PiEcho 侧表现为「客服胡说」，排查成本极高（§14.3）。

### 7.10 离线同步建议（供 PiEcho 参考，非 DShop 责任）

| 数据 | 建议策略 |
| --- | --- |
| 商品规格 `/specs` | 每日全量/增量拉取，用 `contentHash` + `ifNoneMatch` 条件请求，命中 `304` 即跳过；写入 PiEcho 本地向量库 |
| 售后政策 `/policies` | 每小时拉取 `category=all`，`contentHash` 变更时重建该分类索引 |
| 订单 / 物流 / 售后单 | **实时查询，不入向量库**（强时效，每次拉最新） |
| 库存 | 实时查询，30s 缓存已由 DShop 侧兜底 |

**DShop 侧承诺**：`contentHash` 在商品参数或政策内容**任何变更**时都会改变（基于规范化后的内容计算，与 `updatedAt` 无关）。这使 PiEcho 的增量同步可以完全依赖 `304`，无需逐字段比对。

### 7.11 Agent 面 SLO（本版新增）

上一稿只规定了 PiEcho 的客户端纪律（超时、重试、熔断），未规定 DShop 侧的服务承诺。既然 DShop 的 Agent 面可用性直接决定 PiEcho 的业务可用性（§1.1），**必须有可度量的 SLO**，否则「PiEcho 优先」无法验收。

| 指标 | 目标 | 度量方式 | 未达标时的动作 |
| --- | --- | --- | --- |
| **可用性**（Agent 组） | 月度 **≥ 99.5%**（允许约 3.6h/月） | 非 5xx 响应占比，按 `agent_call_logs` 聚合 | 触发复盘；连续两月未达标则启用 S10 独立 Worker 隔离 |
| **大陆可达性** | **100%**（无备案/域名问题时） | 从大陆节点定时探测 `api.dshop.example.com` | P0 故障，立即排查（§11.3） |
| **延迟 P95**（单端点） | **< 300ms**；缓存命中路径 < 100ms | `agent_call_logs.duration_ms` 分位数 | 排查 D1 读放大；必要时启用 S11 只读副本 |
| **限流拒绝率** | < 1%（正常会话量下） | `42901` 占比 | 评估配额调整（§7.8.4 流程） |
| **契约稳定性** | 破坏性变更 **0 次/月**（发布前经 CI 门禁） | 契约快照 diff 记录 | 立即回滚；启动双版本并行 |
| **数据新鲜度** | 库存 ≤ 30s、商品规格 ≤ 5min、政策 ≤ 1h、订单/售后实时 | 缓存 TTL 配置 + `updatedAt` 比对 | 检查缓存失效逻辑（后台写操作是否主动失效） |

**SLO 报告**：平台后台提供「Agent 配额与健康看板」（M1 交付，§12），展示上述六项指标的实时值与趋势。**PiEcho 侧应有只读访问权**，便于其自行判断降级时机——这属于耦合点 C1 的一部分（§14.2）。

### 7.12 受控写能力（设计预案，默认关闭；决策项 Q5）

**现状**：Agent 组默认 GET-only（§7.8.3）。这带来一个能力上限——PiEcho 只能**告知**，不能**代办**。用户说「帮我把收货地址改成公司地址」，PiEcho 只能回答「请您到商城订单页自行修改」。

**本节是预案**，不在一期默认范围内。是否启用由 **Q5** 决策（§2.5.2）。本节说明若启用需要哪些设计，以便评审时权衡代价。

| 候选端点 | 语义 | 前置条件 | 风险 |
| --- | --- | --- | --- |
| `POST /agent/orders/{orderNo}/cancel` | 取消**未支付**订单 | 订单状态为 `PENDING_PAYMENT` 且属于该用户 | 低——仅释放库存锁定，无资金流 |
| `POST /agent/orders/{orderNo}/address` | 修改**未发货**订单的收货地址 | 主单无任何子单已发货 | 中——涉及收货信息，需二次确认 |
| `POST /agent/aftersales` | 代客发起售后申请 | 订单在售后时效内 | 中——涉及退款资金 |

**若启用，必须同时落地的六项约束**（缺一不可）：

1. **独立权限点**：新增 `agent:order:write` / `agent:aftersale:write` scope，与读 scope 分离。**令牌默认不含写 scope**——需要显式勾选，且签发时二次确认。
2. **强制幂等**：所有写端点必须携带 `Idempotency-Key`，落 `idempotency_keys`（`scope='agent'`），重放返回首次结果（§5.3 ③）。
3. **二次确认协议**：DShop 侧要求请求体含 `confirmToken`——由一次独立的 `POST /agent/confirmations` 换取（返回一次性 token，有效期 60s，绑定具体操作与订单号）。**防止模型误解用户意图后直接执行**。
4. **状态机守卫**：写操作只允许在合法状态转换下执行，否则返回 `40901`（如已发货订单不允许改地址）。
5. **独立审计**：写操作落 `audit_logs`（操作者类型 `agent`，记录 `token_id`），并**在用户侧可见**——用户在商城订单页能看到「客服助手代您修改了收货地址」。
6. **限流更严**：写端点配额独立且远低于读（建议 **10 次/分钟/令牌**），防止误操作批量执行。

**不建议启用的操作（明确排除）**：任何涉及**资金划转**（退款审批、结算）、**商品与价格修改**、**用户账号信息**（手机号、密码）的操作——这些必须回到商城界面由人工完成。

**决策建议**：一期**不启用**，把只读能力做扎实（数据完备 + SLO 达标）。若 PiEcho 侧的 Golden 场景（`seed.md` 场景一~四）全部通过且运营反馈「代办需求高频」，再在二期按上述六项约束打开。理由：受控写的安全面远大于读，而一期的核心风险是「PiEcho 拿不到准确数据」，不是「PiEcho 不能代办」。

### 7.13 端点演进路线（按客服问题覆盖度）

六端点不是上限。演进依据是**客服实际高频问题**与 `seed.md` 场景覆盖度，而非商城功能的完整度。

| 优先级 | 端点 | 覆盖的客服问题 | 状态 |
| --- | --- | --- | --- |
| — | 现有六端点 | 订单/物流/规格/库存/售后/政策 | **M0 交付** |
| P1 | `GET /agent/orders/by-tracking/{trackingNo}` | 「我只有一个快递单号，帮我查订单」（用户常只给物流单号） | M2 评估 |
| P1 | `GET /agent/aftersales?phone=` | 「我寄回的退货到哪了」（用户只报手机号，不知售后单号） | M2 评估 |
| P2 | `GET /agent/orders/batch?orderNos=` | 会话内多单查询的往返开销（客服问「我最近几单都发了吗」） | M3 评估 |
| P2 | `GET /agent/products/{spuId}/faq` | 商品级 FAQ（非政策类的高频问答） | M3 评估 |
| P3 | Webhook 推送 | 订单/售后状态变更主动推送，替代部分轮询 | 本期明确不做（需评估接收端与重试语义） |

**新增端点的准入条件**：① 有明确的客服高频问题支撑（来自 PiEcho 侧的未覆盖问题统计）；② 不扩大脱敏面（§7.8.2）；③ 走 §7.9 变更流程（新增端点属非破坏性变更，不升版本）。

**PiEcho 侧的反馈通道**：PiEcho 在运营中统计「Agent 无法回答的问题类型」，定期（建议每两周）向 DShop 提交清单；DShop 按上表优先级评估。这是 §14.4「未覆盖的问题类型」约定的落地机制。

---
