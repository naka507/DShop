/**
 * 首个超管 bootstrap 路径的守卫测试。
 *
 * 背景：`0002_seed.sql` 按 `docs/M0-字段契约.md` §11 **不插入** `admin_users`（口令哈希不得硬编码），
 * 于是「首个超管从哪来」必须有一条**真实存在**的路径。历史上该契约把这条路径错记为
 * `scripts/build-seed-sql.ts`，而该脚本零 admin 引用、且其产物 `data/seed-cs/seed_cs.sql`
 * 仅供 dev/staging（文件头明确「生产环境不得导入」）——即**结构上无法** bootstrap 生产超管。
 * 结果是线上库 `admin_users` 为 0 行：登不进后台 → `POST /api/v1/admin/agent-tokens` 不可达 →
 * PiEcho 服务令牌永远签不出来。
 *
 * 本测试把这条链路钉死，防止再次静默退化。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（`packages/db/tests` → 上三级）。 */
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const SEED_ADMIN = "scripts/seed-admin.ts";
const BUILD_SEED_SQL = "scripts/build-seed-sql.ts";
const SEED_MIGRATION = "packages/db/migrations/0002_seed.sql";
const M0_CONTRACT = "docs/M0-字段契约.md";

describe("首个超管 bootstrap 路径", () => {
  it("`scripts/seed-admin.ts` 存在，且由根 `package.json` 的 `seed:admin` 指向", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.["seed:admin"];
    expect(script, "根 package.json 缺少 seed:admin 脚本").toBeDefined();
    expect(script).toContain(SEED_ADMIN);

    // 文件本身必须存在且非空（readRepoFile 会抛 ENOENT）。
    expect(readRepoFile(SEED_ADMIN).length).toBeGreaterThan(1000);
  });

  it("口令只经环境变量注入，绝不走 argv、绝不落盘", () => {
    const source = readRepoFile(SEED_ADMIN);

    // 只读环境变量。
    expect(source).toMatch(/process\.env\[["']ADMIN_INITIAL_PASSWORD["']\]/u);
    // 不得把口令做成命令行参数（会落入 shell 历史）。
    expect(source).not.toMatch(/--password/u);
    // 不得写文件：明文口令与 TOTP 密钥只能出现在 stdout。
    expect(source).not.toMatch(/writeFileSync|appendFileSync|createWriteStream/u);
  });

  it("口令哈希与 TOTP 密钥均现场派生（不硬编码）", () => {
    const source = readRepoFile(SEED_ADMIN);
    expect(source).toMatch(/hashPassword/u);
    expect(source).toMatch(/generateTotpSecret/u);
    // 哈希不得硬编码进仓库（脚本内不得出现成品 pbkdf2 串）。
    expect(source).not.toMatch(/pbkdf2\$sha256\$\d+\$[A-Za-z0-9_-]{10,}/u);
  });

  it("同时产出 admin_users 与 admin_user_roles 的幂等 SQL", () => {
    const source = readRepoFile(SEED_ADMIN);
    expect(source).toMatch(/INSERT INTO admin_users/u);
    expect(source).toMatch(/INSERT INTO admin_user_roles/u);
    // 幂等：可安全重复执行。
    expect(source).toMatch(/ON CONFLICT\s*\(\s*username\s*\)\s*DO UPDATE/u);
    expect(source).toMatch(/ON CONFLICT\s*\(\s*admin_user_id\s*,\s*role_id\s*\)\s*DO NOTHING/u);
  });

  it("默认绑定 `platform_super_admin`（令牌签发所需权限 `agent:token:manage` 的持有者）", () => {
    expect(readRepoFile(SEED_ADMIN)).toMatch(/platform_super_admin/u);
  });

  it("`0002_seed.sql` 不插入 admin_users（口令哈希不得硬编码）", () => {
    const sql = readRepoFile(SEED_MIGRATION);
    expect(sql).not.toMatch(/INSERT INTO admin_users/iu);
  });

  it("迁移与契约都不得把超管 bootstrap 指回 `build-seed-sql.ts`", () => {
    // `build-seed-sql.ts` 零 admin 引用，且产物仅供 dev/staging——结构上无法 bootstrap 生产超管。
    // 只禁**肯定式断言**（把该脚本说成超管口令哈希的派生者）；「不得改指…」这类否定式警示是允许的，
    // 故不能简单按「同一行出现脚本名」判红（警示行自身也含脚本名）。
    const FORBIDDEN = [
      // 「由 `scripts/build-seed-sql.ts` …」
      /由\s*`?scripts\/build-seed-sql\.ts/u,
      // 「`scripts/build-seed-sql.ts` 用 `@dshop/auth` 的 hashPassword」
      /build-seed-sql\.ts`?[\s\S]{0,24}?@dshop\/auth/u,
      // 「`scripts/build-seed-sql.ts`（现场）派生」
      /build-seed-sql\.ts`?[\s\S]{0,12}?派生/u,
    ];
    for (const file of [SEED_MIGRATION, M0_CONTRACT]) {
      const text = readRepoFile(file);
      const offenders = FORBIDDEN.filter((pattern) => pattern.test(text)).map(String);
      expect(
        offenders,
        `${file} 仍把超管口令哈希归给 build-seed-sql.ts（该脚本零 admin 引用）`,
      ).toEqual([]);
    }
  });

  it("`build-seed-sql.ts` 的产物确为 dev/staging 专用（这正是它不能 bootstrap 生产的原因）", () => {
    const source = readRepoFile(BUILD_SEED_SQL);
    expect(source).toMatch(/data\/seed-cs\/seed_cs\.sql/u);
    // 文件头须保留「生产环境不得导入」的约束。
    expect(source).toMatch(/生产环境不得导入/u);
    // 零 admin 引用：它从来没有、也不该派生超管。
    expect(source).not.toMatch(/admin_users/u);
  });

  it("契约 §11 把超管 bootstrap 指向 seed-admin.ts", () => {
    expect(readRepoFile(M0_CONTRACT)).toMatch(/scripts\/seed-admin\.ts/u);
  });
});
