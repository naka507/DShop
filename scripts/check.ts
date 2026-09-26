#!/usr/bin/env node
/**
 * scripts/check.ts —— 聚合自检：各 workspace 的 `typecheck` + `test` + 种子自检。
 *
 * 用法：
 *   npx tsx scripts/check.ts
 *
 * ## 工作区发现（自动，非硬编码）
 *
 * 从根 `package.json` 的 `workspaces` 通配（`apps/*`、`packages/*`）展开，
 * 凡是含 `package.json` 的目录即纳入。每个工作区按其**自身 scripts** 执行：
 *   - 有 `typecheck` → 跑 `npm run typecheck`
 *   - 有 `test`      → 跑 `npm run test`
 * 因此**新增 app/package 无需改本文件**即可被闸门覆盖。
 *
 * 末尾追加 `node data/seed-cs/verify.mjs`（种子数据自检）。
 *
 * 任一子任务失败 → 整体退出码非 0。
 * 实现：`node:child_process` 的 `spawnSync` + `shell: true`（Windows 兼容）。
 *
 * ⚠️ `vitest run` 在**没有任何测试文件**的 workspace 会以退出码 1 退出（"No test files found"）。
 *    本脚本把这种情况标记为 `NO-TESTS` 并**不计为失败**。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* -------------------------------------------------------------------------- */
/* 工作区发现                                                                  */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

function readManifest(dir: string): PackageManifest | undefined {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

/**
 * 展开根 `workspaces` 通配为实际工作区目录（相对仓库根，POSIX 分隔符）。
 *
 * 仅支持 `dir/*` 形式（DShop 实际使用的形式）；不支持嵌套通配，避免过度工程。
 */
function discoverWorkspaces(): string[] {
  const rootManifest = readManifest(REPO_ROOT);
  const patterns =
    (rootManifest as { workspaces?: readonly string[] } | undefined)?.workspaces ?? [];
  const found: string[] = [];

  for (const pattern of patterns) {
    const starAt = pattern.indexOf("*");
    if (starAt === -1) {
      // 字面路径：直接检查
      if (readManifest(join(REPO_ROOT, pattern))) found.push(pattern);
      continue;
    }
    const parentRel = pattern.slice(0, starAt).replace(/\/+$/, "");
    const parentAbs = join(REPO_ROOT, parentRel);
    if (!existsSync(parentAbs)) continue;
    for (const entry of readdirSync(parentAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${parentRel}/${entry.name}`;
      if (readManifest(join(REPO_ROOT, rel))) found.push(rel);
    }
  }

  return found.sort();
}

/* -------------------------------------------------------------------------- */
/* 子任务定义                                                                  */
/* -------------------------------------------------------------------------- */

interface SubTask {
  /** 展示名。 */
  readonly name: string;
  /** 执行目录（相对仓库根）。 */
  readonly cwd: string;
  /** 命令行（经 `shell: true` 执行）。 */
  readonly command: string;
  /** 输出中出现该串且退出码非 0 时，视为「无测试文件」而非失败。 */
  readonly noTestsMarker?: string;
}

const NO_TESTS_MARKER = "No test files found";

/** 按工作区自身 scripts 生成子任务（缺哪个 script 就跳过哪个）。 */
function tasksForWorkspace(workspace: string): SubTask[] {
  const manifest = readManifest(join(REPO_ROOT, workspace));
  const scripts = manifest?.scripts ?? {};
  const tasks: SubTask[] = [];
  const label = manifest?.name ?? workspace;

  if (scripts["typecheck"] !== undefined) {
    tasks.push({
      name: `${label} :: typecheck`,
      cwd: workspace,
      command: "npm run typecheck",
    });
  }
  if (scripts["test"] !== undefined) {
    tasks.push({
      name: `${label} :: test`,
      cwd: workspace,
      command: "npm run test",
      noTestsMarker: NO_TESTS_MARKER,
    });
  }
  return tasks;
}

const WORKSPACES = discoverWorkspaces();

const TASKS: readonly SubTask[] = [
  ...WORKSPACES.flatMap(tasksForWorkspace),
  {
    name: "data/seed-cs :: verify.mjs",
    cwd: ".",
    command: "node data/seed-cs/verify.mjs",
  },
];

/* -------------------------------------------------------------------------- */
/* 执行                                                                        */
/* -------------------------------------------------------------------------- */

type Outcome = "PASS" | "FAIL" | "NO-TESTS";

interface TaskResult {
  readonly name: string;
  readonly outcome: Outcome;
  readonly durationMs: number;
  readonly exitCode: number | null;
}

function runTask(task: SubTask): TaskResult {
  const startedAt = Date.now();
  const result = spawnSync(task.command, {
    cwd: resolve(REPO_ROOT, task.cwd),
    shell: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status;
  const combined = `${stdout}\n${stderr}`;

  let outcome: Outcome;
  if (exitCode === 0) {
    outcome = "PASS";
  } else if (task.noTestsMarker !== undefined && combined.includes(task.noTestsMarker)) {
    outcome = "NO-TESTS";
  } else {
    outcome = "FAIL";
  }

  if (outcome !== "PASS") {
    // 失败/无测试时打印原始输出，便于定位（stdout 与 stderr 分开标注）。
    console.log(`----- ${task.name} :: stdout -----`);
    process.stdout.write(stdout.endsWith("\n") || stdout === "" ? stdout : `${stdout}\n`);
    console.log(`----- ${task.name} :: stderr -----`);
    process.stdout.write(stderr.endsWith("\n") || stderr === "" ? stderr : `${stderr}\n`);
    console.log("----- 输出结束 -----");
  }

  return { name: task.name, outcome, durationMs, exitCode };
}

function main(): void {
  console.log(`[check] 仓库根：${REPO_ROOT}`);
  console.log(`[check] 发现工作区（${String(WORKSPACES.length)}）：${WORKSPACES.join(", ")}`);
  console.log(`[check] 子任务数：${String(TASKS.length)}`);
  console.log("");

  const startedAt = Date.now();
  const results: TaskResult[] = [];
  for (const task of TASKS) {
    console.log(`[check] ▶ ${task.name}`);
    const result = runTask(task);
    results.push(result);
    const label =
      result.outcome === "PASS"
        ? "✅ PASS"
        : result.outcome === "NO-TESTS"
          ? "⚪ NO-TESTS"
          : "❌ FAIL";
    console.log(
      `[check] ${label} ${task.name}（exit=${String(result.exitCode)}，${String(result.durationMs)}ms）`,
    );
  }
  const totalMs = Date.now() - startedAt;

  const passed = results.filter((r) => r.outcome === "PASS").length;
  const noTests = results.filter((r) => r.outcome === "NO-TESTS").length;
  const failed = results.filter((r) => r.outcome === "FAIL");

  console.log("");
  console.log("=".repeat(78));
  console.log("[check] 汇总");
  for (const result of results) {
    const label =
      result.outcome === "PASS"
        ? "PASS    "
        : result.outcome === "NO-TESTS"
          ? "NO-TESTS"
          : "FAIL    ";
    console.log(
      `  ${label} ${String(result.durationMs).padStart(6)}ms  exit=${String(result.exitCode)}  ${result.name}`,
    );
  }
  console.log("=".repeat(78));
  console.log(
    `[check] 结果：${String(passed)} 通过 / ${String(noTests)} 无测试 / ${String(failed.length)} 失败；总耗时 ${String(totalMs)}ms`,
  );

  if (failed.length > 0) {
    console.log("[check] 失败项：");
    for (const result of failed)
      console.log(`  - ${result.name}（exit=${String(result.exitCode)}）`);
    process.exit(1);
  }
  console.log("[check] ALL GREEN");
}

main();
