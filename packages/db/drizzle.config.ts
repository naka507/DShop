import { defineConfig } from "drizzle-kit";

/**
 * `drizzle-kit generate` 配置（仅作后续 schema 演进用）。
 *
 * M0 的建表 DDL 是**手写**的 `migrations/0001_init.sql`（与 schema 逐列一致），
 * 因此本配置不参与 M0 落地流程，不要求现在能跑通 generate。
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
