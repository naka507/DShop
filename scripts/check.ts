#!/usr/bin/env node
/**
 * scripts/check.ts —— 聚合自检：各 workspace 的 `tsc --noEmit` + `vitest run` + 种子自检。
 *
 * 用法：
 *   npx tsx scripts/check.ts
 *
 * 依次执行（每个子任务单独计时、失败不阻断后续，最后汇总）：
 *   1. packages/shared   → npx tsc --noEmit / npx vitest run
 *   2. packages/db       → npx tsc --noEmit / npx vitest run
 *   3. packages/auth     → npx tsc --noEmit / npx vitest run
 *   4. packages/services → npx tsc --noEmit / npx vitest run
 *   5. apps/api          → npx tsc --noEmit / npx vitest run
 *   6. node data/seed-cs/verify.mjs
 *
 * 任一子任务失败 → 整体退出码非 0。
 * 实现：`node:child_process` 的 `spawnSync` + `shell: true`（Windows 兼容）。
 *
 * ⚠️ `vitest run` 在**没有任何测试文件**的 workspace 会以退出码 1 退出（"No test files found"）。
 *    本脚本把这种情况标记为 `NO-TESTS` 并**不计为失败**（`apps/api` 当前即如此）。
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* -------------------------------------------------------------------------- */
/* 子任务定义                                                                  */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 需要 typecheck + test 的 workspace（相对仓库根）。 */
const WORKSPACES: readonly string[] = [
  "packages/shared",
  "packages/db",
  "packages/auth",
  "packages/services",
  "apps/api",
];

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

const TASKS: readonly SubTask[] = [
  ...WORKSPACES.flatMap((workspace): SubTask[] => [
    { name: `${workspace} :: tsc --noEmit`, cwd: workspace, command: "npx tsc --noEmit" },
    {
      name: `${workspace} :: vitest run`,
      cwd: workspace,
      command: "npx vitest run",
      noTestsMarker: "No test files found",
    },
  ]),
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
  } else if (
    task.noTestsMarker !== undefined &&
    combined.includes(task.noTestsMarker)
  ) {
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
  console.log(`[check] 子任务数：${TASKS.length}`);
  console.log("");

  const startedAt = Date.now();
  const results: TaskResult[] = [];
  for (const task of TASKS) {
    console.log(`[check] ▶ ${task.name}`);
    const result = runTask(task);
    results.push(result);
    const label =
      result.outcome === "PASS" ? "✅ PASS" : result.outcome === "NO-TESTS" ? "⚪ NO-TESTS" : "❌ FAIL";
    console.log(
      `[check] ${label} ${task.name}（exit=${String(result.exitCode)}，${result.durationMs}ms）`,
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
      result.outcome === "PASS" ? "PASS    " : result.outcome === "NO-TESTS" ? "NO-TESTS" : "FAIL    ";
    console.log(
      `  ${label} ${String(result.durationMs).padStart(6)}ms  exit=${String(result.exitCode)}  ${result.name}`,
    );
  }
  console.log("=".repeat(78));
  console.log(
    `[check] 结果：${passed} 通过 / ${noTests} 无测试 / ${failed.length} 失败；总耗时 ${totalMs}ms`,
  );

  if (failed.length > 0) {
    console.log("[check] 失败项：");
    for (const result of failed) console.log(`  - ${result.name}（exit=${String(result.exitCode)}）`);
    process.exit(1);
  }
  console.log("[check] ALL GREEN");
}

main();
