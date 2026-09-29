#!/usr/bin/env node
/**
 * scripts/seed-admin.ts —— 创建 / 重置一个后台超管账号，并打印**可直接执行的 SQL**。
 *
 * 用法：
 *   ADMIN_INITIAL_PASSWORD='...' npx tsx scripts/seed-admin.ts
 *   ADMIN_INITIAL_PASSWORD='...' npx tsx scripts/seed-admin.ts --username admin --nickname "平台超管"
 *   ADMIN_INITIAL_PASSWORD='...' npx tsx scripts/seed-admin.ts --role platform_operator
 *   ADMIN_INITIAL_PASSWORD='...' npx tsx scripts/seed-admin.ts --rotate-totp
 *
 * 参数：
 *   --username <账号>   登录名（默认 `admin`；须匹配 `uq_admin_users_username` 唯一索引）
 *   --nickname <昵称>   显示名（默认 `平台超管`）
 *   --role <角色 code>  绑定的角色，取值照 `roles.code`（默认 `platform_super_admin`，
 *                       由 packages/db/migrations/0002_seed.sql 内置）
 *   --no-totp           不启用 TOTP（⚠️ 启用后 `POST /api/v1/admin/agent-tokens` 将永久不可用）
 *   --rotate-totp       账号已存在时也重发 TOTP 密钥（默认**保留**已绑定的验证器）
 *
 * 环境变量：
 *   ADMIN_INITIAL_PASSWORD  初始口令（**必填**，无默认值；长度 ≥ 12）
 *
 * 输出（stdout）：
 *   1) TOTP 密钥 + otpauth 配置 URI（仅 `--no-totp` 之外的情况；**仅显示一次**）
 *   2) `INSERT INTO admin_users ... ON CONFLICT(username) DO UPDATE SET ...;`
 *      `INSERT INTO admin_user_roles ... ON CONFLICT(admin_user_id, role_id) DO NOTHING;`
 *   3) 摘要（账号 / 角色 / TOTP 是否启用 / 口令哈希前缀）
 *
 * ⚠️ **明文口令与 TOTP 密钥绝不写入任何文件**；本脚本只读环境变量、只写 stdout。
 * ⚠️ 口令**不走命令行参数**（会落进 shell 历史），只能经 `ADMIN_INITIAL_PASSWORD` 注入。
 *
 * 为什么需要本脚本：`packages/db/migrations/0002_seed.sql` 按 docs/M0-字段契约.md §11
 * 只种入 `roles`，**不**插入 `admin_users`（口令哈希必须现场派生、不得硬编码）。
 * 而 `scripts/build-seed-sql.ts` 的产物 `data/seed-cs/seed_cs.sql` 仅供 dev/staging
 * （其文件头明确「生产环境不得导入」），故生产首个超管只能由本脚本 bootstrap。
 */

import { generateTotpSecret, hashPassword, totpProvisioningUri } from "@dshop/auth";
import { ADMIN_USER_STATUS, newId } from "@dshop/shared";

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** 口令最小长度（比契约 §11 的 `admin123` 示例更严：示例口令本身不达标准）。 */
const MIN_PASSWORD_LENGTH = 12;

/** 内置超管角色 code（0002_seed.sql 的 `roles` 行之一）。 */
const DEFAULT_ROLE_CODE = "platform_super_admin";

/* -------------------------------------------------------------------------- */
/* 参数解析                                                                    */
/* -------------------------------------------------------------------------- */

interface Options {
  readonly username: string;
  readonly nickname: string;
  readonly roleCode: string;
  readonly totpEnabled: boolean;
  readonly rotateTotp: boolean;
}

/** 解析 `--key value` / `--flag` 形式的参数；未知参数即报错（避免静默忽略拼写错误）。 */
function parseArgs(argv: readonly string[]): Options {
  let username = "admin";
  let nickname = "平台超管";
  let roleCode = DEFAULT_ROLE_CODE;
  let totpEnabled = true;
  let rotateTotp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--username": {
        if (value === undefined || value.startsWith("--")) throw new Error("--username 缺少值");
        username = value;
        i += 1;
        break;
      }
      case "--nickname": {
        if (value === undefined || value.startsWith("--")) throw new Error("--nickname 缺少值");
        nickname = value;
        i += 1;
        break;
      }
      case "--role": {
        if (value === undefined || value.startsWith("--")) throw new Error("--role 缺少值");
        roleCode = value;
        i += 1;
        break;
      }
      case "--no-totp": {
        totpEnabled = false;
        break;
      }
      case "--rotate-totp": {
        rotateTotp = true;
        break;
      }
      default: {
        throw new Error(
          `未知参数：${String(flag)}（支持 --username/--nickname/--role/--no-totp/--rotate-totp）`,
        );
      }
    }
  }

  if (username.length === 0) throw new Error("--username 不能为空");
  if (roleCode.length === 0) throw new Error("--role 不能为空");
  return { username, nickname, roleCode, totpEnabled, rotateTotp };
}

/** 读取并校验初始口令（**只经环境变量**，不走 argv）。 */
function readInitialPassword(username: string): string {
  const password = process.env["ADMIN_INITIAL_PASSWORD"];
  if (password === undefined || password.length === 0) {
    throw new Error(
      "缺少环境变量 ADMIN_INITIAL_PASSWORD（初始口令必须显式注入；不接受命令行参数以免落入 shell 历史）",
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `ADMIN_INITIAL_PASSWORD 长度须 ≥ ${String(MIN_PASSWORD_LENGTH)}，当前 ${String(password.length)}`,
    );
  }
  if (password === username) {
    throw new Error("ADMIN_INITIAL_PASSWORD 不得与用户名相同");
  }
  return password;
}

/* -------------------------------------------------------------------------- */
/* SQL 渲染                                                                    */
/* -------------------------------------------------------------------------- */

/** 转义单引号（`'` → `''`）并加引号。 */
function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/**
 * `admin_users` 的插入语句（幂等：`ON CONFLICT(username) DO UPDATE`）。
 *
 * `--rotate-totp` 未开启时**不触碰** `totp_secret` / `totp_enabled`，
 * 以免重设口令时把已绑定的验证器踢掉。
 */
function renderAdminUserSql(params: {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly nickname: string;
  readonly totpSecret: string | null;
  readonly totpEnabled: boolean;
  readonly rotateTotp: boolean;
  readonly now: string;
}): string {
  const columns = [
    "id",
    "username",
    "password_hash",
    "nickname",
    "status",
    "totp_secret",
    "totp_enabled",
    "failed_attempts",
    "locked_until",
    "created_at",
    "updated_at",
  ];
  const values = [
    sqlString(params.id),
    sqlString(params.username),
    sqlString(params.passwordHash),
    sqlString(params.nickname),
    sqlString(ADMIN_USER_STATUS.ACTIVE),
    params.totpSecret === null ? "NULL" : sqlString(params.totpSecret),
    params.totpEnabled ? "1" : "0",
    "0",
    "NULL",
    sqlString(params.now),
    sqlString(params.now),
  ];
  const assignments = [
    "password_hash = excluded.password_hash",
    "nickname = excluded.nickname",
    "status = excluded.status",
    // 重设口令顺带解锁：否则被锁的账号即使改了口令也登不进去。
    "failed_attempts = 0",
    "locked_until = NULL",
    "updated_at = excluded.updated_at",
  ];
  if (params.rotateTotp) {
    assignments.push("totp_secret = excluded.totp_secret");
    assignments.push("totp_enabled = excluded.totp_enabled");
  }
  return [
    `INSERT INTO admin_users (${columns.join(", ")}) VALUES`,
    `  (${values.join(", ")})`,
    `ON CONFLICT(username) DO UPDATE SET ${assignments.join(", ")};`,
  ].join("\n");
}

/**
 * `admin_user_roles` 的关联语句（幂等：`ON CONFLICT(admin_user_id, role_id) DO NOTHING`）。
 *
 * 两个 id 都用**自然键子查询**解析，而不是复用上面的随机 id：
 * 账号/角色已存在时 `DO UPDATE` 不会改写主键，写死随机 id 会挂到不存在的行上。
 */
function renderAdminUserRoleSql(params: {
  readonly id: string;
  readonly username: string;
  readonly roleCode: string;
  readonly now: string;
}): string {
  return [
    "INSERT INTO admin_user_roles (id, admin_user_id, role_id, created_at) VALUES",
    `  (${sqlString(params.id)},`,
    `   (SELECT id FROM admin_users WHERE username = ${sqlString(params.username)}),`,
    `   (SELECT id FROM roles WHERE code = ${sqlString(params.roleCode)}),`,
    `   ${sqlString(params.now)})`,
    "ON CONFLICT(admin_user_id, role_id) DO NOTHING;",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const password = readInitialPassword(options.username);

  const now = new Date().toISOString();
  const id = newId();
  const passwordHash = await hashPassword(password);

  const totpSecret = options.totpEnabled ? generateTotpSecret() : null;

  const adminUserSql = renderAdminUserSql({
    id,
    username: options.username,
    passwordHash,
    nickname: options.nickname,
    totpSecret,
    totpEnabled: options.totpEnabled,
    rotateTotp: options.rotateTotp,
    now,
  });
  const adminUserRoleSql = renderAdminUserRoleSql({
    id: newId(),
    username: options.username,
    roleCode: options.roleCode,
    now,
  });

  const bar = "=".repeat(72);
  if (totpSecret !== null) {
    console.log(bar);
    console.log("⚠️  TOTP 密钥（仅显示一次，请立即导入验证器 App）：");
    console.log(`    ${totpSecret}`);
    console.log(`    ${totpProvisioningUri(totpSecret, options.username)}`);
    console.log("    未启用 TOTP 的账号**无法**签发 Agent 服务令牌（强制二次验证）。");
    console.log(bar);
    console.log("");
  }
  console.log("-- 可执行 SQL（幂等：ON CONFLICT(...) DO UPDATE / DO NOTHING）");
  console.log(adminUserSql);
  console.log("");
  console.log(adminUserRoleSql);
  console.log("");
  console.log("-- 摘要");
  console.log(`username        : ${options.username}`);
  console.log(`nickname        : ${options.nickname}`);
  console.log(`role            : ${options.roleCode}`);
  console.log(`totp_enabled    : ${options.totpEnabled ? "1" : "0（⚠️ 无法签发服务令牌）"}`);
  console.log(`password_hash   : ${passwordHash.slice(0, 24)}…（${String(passwordHash.length)} 字符）`);
  console.log(`id              : ${id}`);
  console.log(`created_at      : ${now}`);
  console.log(`ADMIN_INITIAL_PASSWORD : <环境注入>（不落盘、不回显）`);
  console.log("");
  console.log("-- 导入（二选一）");
  console.log("wrangler d1 execute dshop-dev --remote --file=<上述 SQL 存成的文件>");
  console.log("wrangler d1 execute dshop-dev --remote --command=\"<上述 SQL 单行化>\"");
}

await main();
