/**
 * DShop Worker 运行时环境绑定（`docs/09` §9.x 部署与配置）。
 *
 * ⚠️ 密钥类绑定（secret）在本地用 `.dev.vars` 提供，生产用 `wrangler secret put`。
 * 文档未定义具体变量名；实现侧按下列命名定案并登记到 `docs/M0-字段契约.md` §8。
 *
 * ## 升级缝纪律（`docs/04` §12.4，对齐 eshop）
 *
 * 付费/高级组件**一律不直接 import**，全部藏在自研接口后面，由**绑定存在性**驱动实现选择：
 * 绑定缺省 → 默认实现（零配置、免费层可用）；加绑定 → 仅该缝切升级实现；删绑定 → 即刻回滚。
 * 因此本文件中所有升级缝绑定必须声明为**可选**（`?`），业务代码禁止直接依赖其存在。
 */
export interface Env {
  /** D1 数据库绑定。 */
  readonly DB: D1Database;

  /**
   * 【S8 升级缝 · 可选】Agent 限流 Durable Object 命名空间。
   *
   * - **缺省（默认实现）**：`apps/api/src/lib/rate-limit-store.ts` 的
   *   `InMemoryRateLimitStore` —— 应用层自研固定窗口计数（isolate 内存，**不写 KV、不依赖 Cache API**），
   *   per-colo 近似配额。
   * - **存在（升级实现）**：`DurableObjectRateLimitStore` —— 跨实例全局精确计数。
   * - **开关方式**：在 `wrangler.jsonc` 增删 `durable_objects` 绑定（+ `migrations`），
   *   代码零改动。删绑定即回滚到默认实现。
   */
  readonly AGENT_RATE_LIMITER?: DurableObjectNamespace;

  /**
   * 【S1 升级缝 · 可选】异步任务队列（Cloudflare Queues）。
   *
   * - **缺省（默认实现）**：`packages/services` 的 `D1TaskQueue` —— 写 `task_queue` 表，
   *   由 Cron 单一入口每分钟轮询消费（`apps/api/src/jobs/index.ts`）。
   * - **存在（升级实现）**：`QueuesTaskQueue` —— `env.TASK_QUEUE.send(...)`。
   * - **开关方式**：在 `wrangler.jsonc` 增删 `queues` 绑定，代码零改动；删绑定即回滚。
   * - **默认实现语义与升级目标对齐**：`task_queue` 表带 `attempts`（已尝试次数）与
   *   `run_at`（下次可运行时间，承载退避）两列——见 `packages/db/src/schema/support.ts`。
   *   注意：本表**没有** `max_attempts` / `next_run_at` 列（升级目标的能力上限由
   *   `packages/services/src/task-queue.ts` 的 `TASK_MAX_ATTEMPTS` 常量承载）。
   *   重试/退避/死信按 Queues 能力设计，切换后**不补逻辑、不迁数据**。
   */
  readonly TASK_QUEUE?: Queue;

  /**
   * 【S2 升级缝 · 可选】D1 只读副本（Sessions API）绑定。
   *
   * - **缺省（默认实现）**：读路径直接用主库 `DB`。
   * - **存在（升级实现）**：读路径走只读副本，写路径仍走 `DB`。
   * - **开关方式**：增删 `d1_databases` 中 binding 为 `READ_DB` 的条目，代码零改动。
   */
  readonly READ_DB?: D1Database;

  /**
   * 【S5 升级缝 · 可选】商品检索索引（Cloudflare Vectorize）。
   *
   * - **缺省（默认实现）**：`D1LikeProductSearch` —— D1 `LIKE` + 简单分词。
   * - **存在（升级实现）**：`VectorizeProductSearch` —— 向量召回。
   * - **开关方式**：增删 `vectorize` 绑定，代码零改动；接口不变，纯内部替换。
   */
  readonly PRODUCT_SEARCH?: VectorizeIndex;

  /**
   * 【S7 升级缝 · 可选】热点缓存叠加层（KV）。
   *
   * - **缺省（默认实现）**：`NoopCachePort` —— **不叠加**（边缘 Cache API 已由
   *   `apps/api/src/lib/cache.ts` 承担，S7 的升级形态是「叠加」而非「切换」）。
   * - **存在（升级实现）**：`KvCachePort` —— 在 Cache API 之上叠加热点 KV。
   * - **开关方式**：增删 `kv_namespaces` 绑定，代码零改动。
   */
  readonly CACHE_KV?: KVNamespace;

  /**
   * 【S6 升级缝 · 可选】媒体存储（R2）。
   *
   * - **缺省（默认实现）**：`NoopMediaPort` —— 不提供上传入口（`presignPut` 返回 `null`）。
   * - **存在（升级实现）**：`R2MediaPort` —— 预签名直传。
   * - **开关方式**：增删 `r2_buckets` 绑定，代码零改动。
   * - **URL 规范已预留变体参数位**（对齐 eshop S6），升级到 Image Resizing 时无需改调用方。
   */
  readonly MEDIA?: R2Bucket;

  /** 服务令牌 pepper：`HMAC-SHA256(AGENT_TOKEN_PEPPER, token明文)`。 */
  readonly AGENT_TOKEN_PEPPER: string;

  /** 手机号等 PII 的 AES-GCM 加密密钥材料（经 SHA-256 派生 32 字节）。 */
  readonly PHONE_ENC_KEY: string;

  /** 手机号等值查询的 HMAC pepper。 */
  readonly PHONE_HASH_PEPPER: string;

  /** JWT HS256 签名密钥。 */
  readonly JWT_SECRET: string;

  /** 环境标识：`development` / `staging` / `production`。 */
  readonly ENVIRONMENT?: string;

  /** 是否要求 Agent 请求签名（`docs/07` §7.8.1，默认关闭）。 */
  readonly AGENT_REQUIRE_SIGNATURE?: string;
}
