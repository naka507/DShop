// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/worker-configuration.d.ts",
      "**/*.config.js",
      "**/*.config.ts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
    },
  },
  {
    // Agent 组禁止 import 任何写路径模块（docs/09 §7.8.3 四重只读之一）
    files: ["apps/api/src/routes/agent/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/repositories/write*", "**/services/write*"],
              message:
                "Agent 路由组为只读：禁止 import 写路径模块（docs/07 §7.8.3 / docs/09 §7.8.3）。",
            },
          ],
        },
      ],
    },
  },
  {
    /*
     * 前端 app（`apps/storefront`、`apps/admin`）的 TSX 需要开启 JSX 解析；
     * typescript-eslint 默认按 `.ts` 解析，不加这块会把每个 JSX 元素报成语法错误。
     */
    files: ["apps/storefront/**/*.tsx", "apps/admin/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.tsx", "**/*.spec.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
  {
    /*
     * Node 侧脚本（`data/seed-cs/verify.mjs` 等）运行在 Node，不是浏览器：
     * 它们需要 `console` / `process` 等全局量。缺这一块会把每个
     * `console.log` 都报成 `no-undef` 错误。
     */
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        crypto: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "no-console": "off",
    },
  },
);
