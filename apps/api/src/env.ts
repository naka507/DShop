/**
 * DShop Worker 运行时环境绑定（`docs/09` §9.x 部署与配置）。
 *
 * ⚠️ 密钥类绑定（secret）在本地用 `.dev.vars` 提供，生产用 `wrangler secret put`。
 * 文档未定义具体变量名；实现侧按下列命名定案并登记到 `docs/M0-字段契约.md` §8。
 */
export interface Env {
  /** D1 数据库绑定。 */
  readonly DB: D1Database;

  /** Agent 限流 Durable Object 命名空间（全局精确限流）。 */
  readonly AGENT_RATE_LIMITER: DurableObjectNamespace;

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
