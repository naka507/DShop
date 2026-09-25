#!/usr/bin/env node
/**
 * scripts/seed-service-token.ts —— 签发一个 Agent 服务令牌，并打印**可直接执行的 SQL**。
 *
 * 用法：
 *   npx tsx scripts/seed-service-token.ts
 *   npx tsx scripts/seed-service-token.ts --name "PiEcho 生产令牌" --scopes agent:order:read,agent:product:read
 *   npx tsx scripts/seed-service-token.ts --rate-limit 1200 --days 90
 *
 * 参数：
 *   --name <名称>        令牌名称（默认 `PiEcho Agent`）
 *   --scopes <逗号分隔>  取值照 `packages/shared/src/enums.ts` 的 `AGENT_SCOPE`
 *                        （默认全部 4 个读 scope）
 *   --rate-limit <每分钟> 令牌级限流（默认 600，07 §7.8.1）
 *   --days <有效期天数>   默认 180（07 §7.8.1）
 *
 * 环境变量：
 *   AGENT_TOKEN_PEPPER   —— `token_hash = HMAC-SHA256(pepper, token)` 的胡椒
 *                          缺省用开发默认值 `dshop-dev-agent-token-pepper`（会打印警告）
 *
 * 输出（stdout）：
 *   1) **明文令牌**（醒目提示「仅显示一次，请立即保存」）
 *   2) `INSERT INTO service_tokens (...) VALUES (...) ON CONFLICT(token_hash) DO UPDATE SET ...;`
 *   3) `token_prefix` / `expires_at` / `scopes` 摘要
 *
 * ⚠️ **明文令牌绝不写入任何文件**；本脚本只读环境变量、只写 stdout。
 * ⚠️ 生产签发应走 `POST /api/v1/admin/agent-tokens`（强制 TOTP + 落审计，07 §7.8.1）；
 *    本脚本仅用于 dev/staging 与本地联调。
 */

import {
  generateServiceToken,
  hashServiceToken,
  serviceTokenPrefix,
  SERVICE_TOKEN_DEFAULT_RATE_LIMIT_PER_MIN,
  SERVICE_TOKEN_TTL_DAYS,
} from "@dshop/auth";
import { AGENT_SCOPE, SERVICE_TOKEN_STATUS, newId } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 环境                                                                        */
/* -------------------------------------------------------------------------- */

const DEV_AGENT_TOKEN_PEPPER = "dshop-dev-agent-token-pepper";
const AGENT_TOKEN_PEPPER = process.env["AGENT_TOKEN_PEPPER"] ?? DEV_AGENT_TOKEN_PEPPER;

/** 允许的 scope 全集（`AGENT_SCOPE` 的四个读 scope，07 §7.8.1）。 */
const ALL_SCOPES: readonly string[] = Object.values(AGENT_SCOPE);

/* -------------------------------------------------------------------------- */
/* 参数解析                                                                    */
/* -------------------------------------------------------------------------- */

interface Options {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly rateLimitPerMin: number;
  readonly days: number;
}

/** 解析 `--key value` 形式的参数；未知参数即报错（避免静默忽略拼写错误）。 */
function parseArgs(argv: readonly string[]): Options {
  let name = "PiEcho Agent";
  let scopes: readonly string[] = ALL_SCOPES;
  let rateLimitPerMin = SERVICE_TOKEN_DEFAULT_RATE_LIMIT_PER_MIN;
  let days = SERVICE_TOKEN_TTL_DAYS;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--name": {
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--name 缺少值");
        }
        name = value;
        i += 1;
        break;
      }
      case "--scopes": {
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--scopes 缺少值");
        }
        const parsed = value
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0);
        if (parsed.length === 0) throw new Error("--scopes 不能为空");
        for (const scope of parsed) {
          if (!ALL_SCOPES.includes(scope)) {
            throw new Error(`未知 scope：${scope}（合法取值：${ALL_SCOPES.join(", ")}）`);
          }
        }
        scopes = [...new Set(parsed)];
        i += 1;
        break;
      }
      case "--rate-limit": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`--rate-limit 须为正整数，收到 ${String(value)}`);
        }
        rateLimitPerMin = parsed;
        i += 1;
        break;
      }
      case "--days": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`--days 须为正整数，收到 ${String(value)}`);
        }
        days = parsed;
        i += 1;
        break;
      }
      default: {
        throw new Error(`未知参数：${String(flag)}（支持 --name/--scopes/--rate-limit/--days）`);
      }
    }
  }

  return { name, scopes, rateLimitPerMin, days };
}

/* -------------------------------------------------------------------------- */
/* SQL 渲染                                                                    */
/* -------------------------------------------------------------------------- */

/** 转义单引号（`'` → `''`）并加引号。 */
function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/** `service_tokens` 的插入语句（幂等：`ON CONFLICT(token_hash) DO UPDATE`）。 */
function renderInsertSql(params: {
  readonly id: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly rateLimitPerMin: number;
  readonly now: string;
}): string {
  const columns = [
    "id",
    "token_hash",
    "token_prefix",
    "name",
    "scopes",
    "status",
    "expires_at",
    "rate_limit_per_min",
    "created_by",
    "created_at",
    "updated_at",
  ];
  const values = [
    sqlString(params.id),
    sqlString(params.tokenHash),
    sqlString(params.tokenPrefix),
    sqlString(params.name),
    sqlString(JSON.stringify(params.scopes)),
    sqlString(SERVICE_TOKEN_STATUS.ACTIVE),
    sqlString(params.expiresAt),
    String(params.rateLimitPerMin),
    // 脚本签发：created_by 记服务身份标识（生产由后台账号 id 填充）。
    sqlString("seed-service-token.ts"),
    sqlString(params.now),
    sqlString(params.now),
  ];
  const assignments = columns
    .filter((column) => column !== "token_hash")
    .map((column) => `${column} = excluded.${column}`);
  return [
    `INSERT INTO service_tokens (${columns.join(", ")}) VALUES`,
    `  (${values.join(", ")})`,
    `ON CONFLICT(token_hash) DO UPDATE SET ${assignments.join(", ")};`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const usingDevPepper = AGENT_TOKEN_PEPPER === DEV_AGENT_TOKEN_PEPPER;
  if (usingDevPepper) {
    console.warn(
      `[seed-service-token] ⚠️ AGENT_TOKEN_PEPPER 未设置 → 回退到开发默认值 "${DEV_AGENT_TOKEN_PEPPER}"`,
    );
    console.warn("[seed-service-token] ⚠️ 该令牌**仅限 dev/staging**，不得用于生产。");
  }

  const token = generateServiceToken();
  const tokenHash = await hashServiceToken(AGENT_TOKEN_PEPPER, token);
  const tokenPrefix = serviceTokenPrefix(token);

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + options.days * 24 * 60 * 60 * 1000).toISOString();
  const id = newId();

  const sql = renderInsertSql({
    id,
    tokenHash,
    tokenPrefix,
    name: options.name,
    scopes: options.scopes,
    expiresAt,
    rateLimitPerMin: options.rateLimitPerMin,
    now,
  });

  const bar = "=".repeat(72);
  console.log(bar);
  console.log("⚠️  明文令牌（仅显示一次，请立即保存到密钥管理系统）：");
  console.log(`    ${token}`);
  console.log("    服务端只存 token_hash（HMAC-SHA256），明文**无法**再次找回。");
  console.log("    传输头：X-Service-Token（非 Bearer，不允许放 query string）。");
  console.log(bar);
  console.log("");
  console.log("-- 可执行 SQL（幂等：ON CONFLICT(token_hash) DO UPDATE SET）");
  console.log(sql);
  console.log("");
  console.log("-- 摘要");
  console.log(`token_prefix        : ${tokenPrefix}`);
  console.log(`expires_at          : ${expiresAt}（now + ${options.days} 天）`);
  console.log(`scopes              : ${options.scopes.join(", ")}`);
  console.log(`rate_limit_per_min  : ${options.rateLimitPerMin}`);
  console.log(`id                  : ${id}`);
  console.log(`created_at          : ${now}`);
  console.log(`AGENT_TOKEN_PEPPER  : ${usingDevPepper ? "<开发默认值>" : "<环境注入>"}`);
}

await main();
