#!/usr/bin/env node
/**
 * scripts/load-seed-local.ts —— 把迁移与种子按顺序加载进本地 D1。
 *
 * 用法：
 *   npx tsx scripts/load-seed-local.ts            # 本地（默认）
 *   npx tsx scripts/load-seed-local.ts --remote   # ⚠️ 写**真实** D1（M0 阶段禁止用于生产）
 *
 * 顺序（逐条 `wrangler d1 execute`，任一步失败立即中止）：
 *   1. packages/db/migrations/0001_init.sql   （41 表 schema）
 *   2. packages/db/migrations/0002_seed.sql   （业务 seed：roles / settings）
 *   3. data/seed-cs/seed_cs.sql               （虚构客服场景数据集，仅 dev/staging）
 *
 * ⚠️ **`--remote` 会写真实数据库**（D1 上的 `dshop-dev` / 线上库）。
 *    M0 阶段**禁止**对生产使用本开关；`seed_cs.sql` 是虚构数据，生产环境不得导入
 *    （`docs/M0-实施简报.md` §7.1）。默认（不带开关）只写本地 `.wrangler/state` 下的本地 D1。
 *
 * 实现：`node:child_process` 的 `spawnSync` + `shell: true`（Windows 兼容），逐条检查退出码。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* -------------------------------------------------------------------------- */
/* 路径与配置                                                                  */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `wrangler.jsonc` 位于 `apps/api/`（D1 绑定与 database_name 的唯一来源）。 */
const WRANGLER_CONFIG = "apps/api/wrangler.jsonc";

/** 加载顺序：迁移 → 业务 seed → 虚构数据集。 */
const FILES: readonly string[] = [
  "packages/db/migrations/0001_init.sql",
  "packages/db/migrations/0002_seed.sql",
  "data/seed-cs/seed_cs.sql",
];

/** D1 数据库名（与 `apps/api/wrangler.jsonc` 的 `d1_databases[0].database_name` 一致）。 */
const DATABASE_NAME = "dshop-dev";

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

function main(): void {
  const remote = process.argv.slice(2).includes("--remote");

  if (remote) {
    console.warn("=".repeat(78));
    console.warn("⚠️⚠️  已启用 --remote：将写**真实** D1 数据库（非本地 .wrangler/state）。");
    console.warn(`     目标数据库：${DATABASE_NAME}（config: ${WRANGLER_CONFIG}）`);
    console.warn("     本操作不可撤销；M0 阶段**禁止**对生产环境使用。");
    console.warn("     `data/seed-cs/seed_cs.sql` 是虚构数据，生产环境不得导入。");
    console.warn("=".repeat(78));
  } else {
    console.log(`[load-seed-local] 目标：本地 D1（database=${DATABASE_NAME}，config=${WRANGLER_CONFIG}）`);
  }

  for (const relativePath of FILES) {
    const absolutePath = resolve(REPO_ROOT, relativePath);
    if (!existsSync(absolutePath)) {
      console.error(`[load-seed-local] ❌ 文件不存在：${absolutePath}`);
      process.exit(1);
    }
  }

  const startedAt = Date.now();
  let executed = 0;

  for (const relativePath of FILES) {
    const args = [
      "wrangler",
      "d1",
      "execute",
      DATABASE_NAME,
      remote ? "--remote" : "--local",
      `--config=${WRANGLER_CONFIG}`,
      `--file=${relativePath}`,
    ];
    const commandLine = `npx ${args.join(" ")}`;
    console.log(`[load-seed-local] ▶ ${commandLine}`);

    const stepStartedAt = Date.now();
    const result = spawnSync(commandLine, { cwd: REPO_ROOT, shell: true, stdio: "inherit" });
    const stepMs = Date.now() - stepStartedAt;

    if (result.error !== undefined) {
      console.error(`[load-seed-local] ❌ 无法启动子进程：${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(
        `[load-seed-local] ❌ 失败：${relativePath}（exit=${String(result.status)}，耗时 ${stepMs}ms）`,
      );
      console.error("[load-seed-local] 已中止，未执行后续文件。");
      process.exit(result.status ?? 1);
    }

    executed += 1;
    console.log(`[load-seed-local] ✅ ${relativePath}（耗时 ${stepMs}ms）`);
  }

  const totalMs = Date.now() - startedAt;
  console.log(
    `[load-seed-local] 全部完成：${executed}/${FILES.length} 个文件，总耗时 ${totalMs}ms` +
      (remote ? "（**--remote 已写真实库**）" : "（本地 D1）"),
  );
}

main();
