# DShop 架构设计 · 第 6 部分

> **内容**：§6 API 路由命名空间（/shop、/admin、/merchant、/callbacks、/agent）
> **导航**：[文档总目录](README.md) ｜ 上一部分：[05-数据模型](05-数据模型.md) ｜ 下一部分：[07-Agent-API契约](07-Agent-API契约.md)

---

## 6. API 路由命名空间

```
/api/v1/shop/...        # C 端：公开浏览 + 会员（HttpOnly Cookie JWT, aud=shop）
/api/v1/merchant/...    # 商户后台（Cookie JWT, aud=merchant）
/api/v1/admin/...       # 平台后台（Cookie JWT, aud=admin）
/api/v1/callbacks/...   # 支付/开放平台回调（验签，无鉴权）
/api/v1/agent/...       # ★ 供 PiEcho 的接口（服务令牌，默认 GET-only）
```

**统一响应体**（五组路由共用）：`{ "code": 0, "message": "ok", "data": { } }`

- `code === 0` 为成功；非 0 为业务错误码，集中在 `packages/shared/src/errors.ts`（如 `ORDER_STOCK_NOT_ENOUGH`、`AGENT_TOKEN_INVALID`）。**错误码类型按路由组区分**：`/api/v1/agent/*` 路由组使用**整数错误码**（`40001`/`40101`/`40401`/`42901` 等，见 §7.1）；`ORDER_STOCK_NOT_ENOUGH` 一类**字符串错误码仅用于 shop / admin / merchant 三组**，两组不混用。
- 分页：**shop / admin / merchant 三组统一 `{ page, pageSize, total, list }`**；**Agent 组统一游标分页 `{ list, nextCursor, hasMore }`**（§7.3），两者不混用。
- 鉴权双模：Web 用 HttpOnly Cookie；小程序/APP 与 Agent 用请求头（`Authorization` / `X-Service-Token`）。

路由示例：

```
GET  /api/v1/shop/products?categoryId=&q=&sort=&page=
POST /api/v1/shop/cart/items              { skuId, quantity }
POST /api/v1/shop/orders                  # Header: Idempotency-Key
POST /api/v1/shop/orders/:orderNo/pay     # 返回按渠道封装的支付参数
POST /api/v1/shop/aftersales

POST /api/v1/merchant/products
POST /api/v1/merchant/sub-orders/:subOrderNo/ship
PUT  /api/v1/merchant/aftersales/:aftersaleNo/approve

POST /api/v1/admin/agent-tokens           # 签发 PiEcho 服务令牌
POST /api/v1/admin/agent-tokens/:id/revoke
POST /api/v1/admin/aftersale-policies     # ★ 售后政策发布（PiEcho 语料来源）
GET  /api/v1/admin/settlements

POST /api/v1/callbacks/wechat-pay         # 微信支付 v3 验签
POST /api/v1/callbacks/alipay

GET  /api/v1/agent/orders/:orderNo        # ★ 见 §7
GET  /api/v1/agent/orders?userId=&limit=
GET  /api/v1/agent/products/:spuId/specs
GET  /api/v1/agent/products/:spuId/stock
GET  /api/v1/agent/aftersales/:aftersaleNo
GET  /api/v1/agent/policies/:category
```

**中间件链（顺序固定）**：`requestId → accessLog → rateLimit(按路由组配额) → auth(aud | serviceToken) → rbac(perm) → merchantScope → zodValidator → handler`

`merchantScope` 是**数据行级隔离**：商户身份的所有查询自动强制注入 `merchant_id = 当前商户`（实现于 `packages/db` 查询层封装），杜绝越权。Agent 组**不走** `merchantScope`（它是跨商户的服务视角），但走独立的令牌 scope 校验。

**Agent 组额外中间件**：`agentReadOnlyGuard`（非 GET 一律 `405`，§7.8.3）与 `agentAudit`（异步写 `agent_call_logs`）。二者仅挂在 `/api/v1/agent/*` 上，不影响其他路由组。

---
