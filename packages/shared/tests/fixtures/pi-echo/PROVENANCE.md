# PiEcho 契约 fixture 来源

本目录下的 12 个 `*.success.json` / `*.error.json` 是从 **PiEcho 仓库**原样复制而来，
用于反向验证 DShop 契约中心（`src/contracts/agent.ts`、`src/errors.ts`）的 Zod Schema。
文件内容**未经任何修改**。

- 来源仓库：`github.com/naka507/PiEcho`
- 来源路径：`tests/contract/fixtures/`
- 来源 commit：`1f14d0585ba52c388d9b02d0af5ec68cfd02b131`（`git rev-parse HEAD`）
- 复制日期：2026（见提交时间）

复制到 DShop 侧的目的是让测试**自包含**：`tests/agent-contract.test.ts` 不依赖 PiEcho
仓库在磁盘上的位置。

> 纪律说明：若某个真实 fixture 被 DShop Schema 拒绝，**不得**为通过测试而放宽 Schema
> 或改写 fixture。fixture 是 PiEcho 侧已按契约文档校验通过的权威样本。

文件清单：

| 文件                                                      | 端点                            |
| --------------------------------------------------------- | ------------------------------- |
| `order.success.json` / `order.error.json`                 | `GET /orders/{orderNo}`         |
| `orders.success.json` / `orders.error.json`               | `GET /orders`                   |
| `product-specs.success.json` / `product-specs.error.json` | `GET /products/{spuId}/specs`   |
| `product-stock.success.json` / `product-stock.error.json` | `GET /products/{spuId}/stock`   |
| `aftersale.success.json` / `aftersale.error.json`         | `GET /aftersales/{aftersaleNo}` |
| `policies.success.json` / `policies.error.json`           | `GET /policies/{category}`      |
