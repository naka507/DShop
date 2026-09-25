/**
 * `@dshop/auth` —— 认证与令牌层（Cloudflare Workers / WebCrypto）。
 *
 * 覆盖：PBKDF2 口令、JWT HS256、TOTP（RFC 6238）、服务令牌、PII 加解密、刷新令牌。
 *
 * **环境约束**：仅用全局 `crypto`（WebCrypto）、`TextEncoder` / `TextDecoder`、`atob` / `btoa`。
 * 注意 `@cloudflare/workers-types` 把 `crypto` 声明为全局 `declare const`（不在 `typeof globalThis` 上），
 * 故本包统一写裸标识符 `crypto`。
 * 不引入 `node:crypto`、`Buffer`、`process`；本包**不读环境变量**，所有密钥/胡椒由调用方注入
 * （`env.JWT_SECRET` / `env.AGENT_TOKEN_PEPPER` / `env.PHONE_HASH_PEPPER` / `env.AGENT_SIGN_SECRET`）。
 */

/* 低层编码与 WebCrypto（供 apps/api 复用，避免各处重写 base64url / hex） */
export * from "./encoding.js";
export * from "./webcrypto.js";

/* 业务模块 */
export * from "./password.js";
export * from "./jwt.js";
export * from "./totp.js";
export * from "./service-token.js";
export * from "./pii.js";
export * from "./refresh-token.js";
