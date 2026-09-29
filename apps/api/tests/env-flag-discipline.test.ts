/**
 * **环境标志不得兼职调试后门**——结构性锁（`docs/09` §9.1、`docs/13` §13.3）。
 *
 * 背景（一次真实线上事故）：自定义域 `api.eshop.eu.cc` 绑的是**顶层** Worker
 * `dshop-api`，而顶层 `wrangler.jsonc` 的 `vars.ENVIRONMENT` 曾是 `"development"`。
 * 于是 `routes/shop/auth.ts` 里那句「`ENVIRONMENT === "development"` 就把短信验证码
 * 固定成 `123456`」在**线上生效**了：任意 11 位手机号都能用 `123456` 登录，
 * 且登录即建号（真实写库）。同时认证 Cookie 丢掉 `Secure`，`/health` 还对外
 * 自报 `environment: development`。
 *
 * 为什么需要这层测试：这不是业务逻辑缺陷，而是**配置语义缺陷**——所有业务测试
 * 都是绿的（测试里 `ENVIRONMENT` 是 `"test"`），只有线上那条真实链路才会中招。
 * 因此本文件把三条纪律钉死在配置与源码两个层面：
 *
 * 1. 顶层配置（= 自定义域实际服务的脚本）的 `ENVIRONMENT` **必须是 `production`**；
 * 2. 固定验证码只能由**显式白名单** `DEMO_FIXED_SMS_CODE` 开启，且线上为空；
 * 3. 短信码生成函数**不得**接受 `ENVIRONMENT`（防止旧写法复活）。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const WRANGLER = resolve(REPO_ROOT, "apps/api/wrangler.jsonc");
const SHOP_AUTH = resolve(REPO_ROOT, "apps/api/src/routes/shop/auth.ts");
const ENV_TS = resolve(REPO_ROOT, "apps/api/src/env.ts");

/**
 * 去掉 JSONC 注释与行尾逗号，返回可 `JSON.parse` 的文本。
 *
 * 用状态机而非逐行正则：正则方案在「字符串里出现 `//` 或 `, }`」时会误判，
 * 锁的是字节而不是语义（与 `upgrade-seam-bindings.test.ts` 同构）。
 */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

interface WranglerConfig {
  name?: string;
  vars?: Record<string, unknown>;
  routes?: { pattern?: string; custom_domain?: boolean }[];
  env?: Record<
    string,
    { name?: string; vars?: Record<string, unknown>; routes?: { pattern?: string }[] }
  >;
}

function readWrangler(): WranglerConfig {
  return JSON.parse(stripJsonc(readFileSync(WRANGLER, "utf8"))) as WranglerConfig;
}

/** 取某作用域的 `vars`。 */
function varsOf(scope: { vars?: Record<string, unknown> } | undefined): Record<string, unknown> {
  return scope?.vars ?? {};
}

describe("环境标志纪律：顶层配置就是线上脚本，`ENVIRONMENT` 必须是 `production`", () => {
  it("顶层 `vars.ENVIRONMENT` 为 `production`（曾经的 `development` 即线上认证绕过）", () => {
    const config = readWrangler();
    expect(
      varsOf(config)["ENVIRONMENT"],
      "顶层配置 = 自定义域 api.eshop.eu.cc 实际服务的脚本；写成 development 会让固定验证码在线上生效",
    ).toBe("production");
  });

  it("**任何**作用域的 `ENVIRONMENT` 都不得为 `development`（逐环境一并钉死）", () => {
    const config = readWrangler();
    const scopes: [string, { vars?: Record<string, unknown> }][] = [
      ["顶层", config],
      ...Object.entries(config.env ?? {}).map(
        ([k, v]) => [`env.${k}`, v] as [string, { vars?: Record<string, unknown> }],
      ),
    ];
    for (const [label, scope] of scopes) {
      expect(
        varsOf(scope)["ENVIRONMENT"],
        `${label} 的 ENVIRONMENT 不得为 development：固定验证码由 DEMO_FIXED_SMS_CODE 白名单决定`,
      ).not.toBe("development");
    }
  });

  it("本地开发的 `development` 语义改由 `.dev.vars` 承担（文件里确实这么写）", () => {
    const example = readFileSync(resolve(REPO_ROOT, "apps/api/.dev.vars.example"), "utf8");
    expect(example).toContain('ENVIRONMENT="development"');
    // 且该文件被 git 忽略（`.dev.vars` 不入库，只有 `.example` 入库）
    const gitignore = readFileSync(resolve(REPO_ROOT, ".gitignore"), "utf8");
    expect(gitignore).toContain(".dev.vars");
  });
});

describe("演示固定码：只能由显式白名单开启，线上必须为空", () => {
  it("顶层（= 线上）的 `DEMO_FIXED_SMS_CODE` 不是通配 `*`", () => {
    const config = readWrangler();
    expect(
      varsOf(config)["DEMO_FIXED_SMS_CODE"],
      "顶层就是线上：设为 `*` 等于任意手机号都能用 123456 登录并建号",
    ).not.toBe("*");
  });

  it("`staging` 与 `production` 两个命名环境的演示白名单为空", () => {
    const envs = readWrangler().env ?? {};
    for (const name of ["staging", "production"]) {
      const block = envs[name];
      expect(block, `env.${name} 必须存在`).toBeDefined();
      expect(
        varsOf(block)["DEMO_FIXED_SMS_CODE"],
        `env.${name} 跑准生产/生产流量路径，演示登录必须关闭`,
      ).toBe("");
    }
  });

  it("`preview` 保留演示白名单（PR 评审需要能进 C 端）", () => {
    const envs = readWrangler().env ?? {};
    expect(varsOf(envs["preview"])["DEMO_FIXED_SMS_CODE"]).toBeTruthy();
  });

  it("`env.ts` 声明了 `DEMO_FIXED_SMS_CODE`，且 `ENVIRONMENT` 的注释写明禁止兼职后门", () => {
    const raw = readFileSync(ENV_TS, "utf8");
    expect(raw).toMatch(/readonly\s+DEMO_FIXED_SMS_CODE\?\s*:/);
    expect(raw).toMatch(/readonly\s+ENVIRONMENT\?\s*:/);
    const idx = raw.indexOf("ENVIRONMENT?:");
    const docblock = raw.slice(Math.max(0, idx - 600), idx);
    expect(docblock, "ENVIRONMENT 的文档块必须写明它不得用来开关调试后门").toContain("不得");
  });
});

describe("短信码生成：不得接受 `ENVIRONMENT`（防旧写法复活）", () => {
  it("`generateSmsCode` 的签名是 (phone, allowlist)，而不是 (environment)", () => {
    const raw = readFileSync(SHOP_AUTH, "utf8");
    // 旧写法：function generateSmsCode(environment: string | undefined)
    expect(raw, "generateSmsCode 不得再以 environment 为参数").not.toMatch(
      /function\s+generateSmsCode\s*\(\s*environment\s*:/,
    );
    // 新写法：function generateSmsCode(phone: string, allowlist: string | undefined)
    expect(raw).toMatch(
      /function\s+generateSmsCode\s*\(\s*phone\s*:\s*string\s*,\s*allowlist\s*:\s*string\s*\|\s*undefined\s*\)/,
    );
  });

  it("源码里不存在「ENVIRONMENT === \"development\" 就固定 123456」的旧模式", () => {
    const raw = readFileSync(SHOP_AUTH, "utf8");
    // 逐字钉住旧表达式：`if (environment === "development") return "123456";`
    expect(raw, "固定验证码不得再挂在环境标志上").not.toMatch(
      /environment\s*===\s*["']development["']\s*\)\s*return\s*["']123456["']/,
    );
    // 固定值只能出现在白名单判定之后
    const idxDemo = raw.indexOf("isDemoPhone(phone, allowlist)");
    const idxLiteral = raw.indexOf('return "123456"');
    expect(idxDemo, "isDemoPhone 判定必须存在").toBeGreaterThan(-1);
    expect(idxLiteral, "固定码必须存在（演示用）").toBeGreaterThan(-1);
    expect(idxLiteral, "固定码必须紧跟白名单判定").toBeGreaterThan(idxDemo);
  });

  it("调用点传的是 `DEMO_FIXED_SMS_CODE` 而非 `ENVIRONMENT`", () => {
    const raw = readFileSync(SHOP_AUTH, "utf8");
    expect(raw).toContain("generateSmsCode(body.data.phone, c.env.DEMO_FIXED_SMS_CODE)");
    expect(raw).not.toContain("generateSmsCode(c.env.ENVIRONMENT)");
  });
});

describe("公网入口纪律：三个 Worker 必须显式关闭 `workers_dev` 与 Preview URL", () => {
  const APPS = ["api", "storefront", "admin"] as const;

  it.each(APPS)("`apps/%s/wrangler.jsonc` 显式写死 `workers_dev: false`", (app) => {
    const raw = readFileSync(resolve(REPO_ROOT, `apps/${app}/wrangler.jsonc`), "utf8");
    const parsed = JSON.parse(stripJsonc(raw)) as {
      workers_dev?: unknown;
      preview_urls?: unknown;
    };
    // 为什么必须**显式**：缺省时 wrangler 每次部署都会默认开启并打印
    // "Because 'workers_dev' is not in your Wrangler file, it will be enabled for this
    //  deployment by default"。实测中一次普通部署就把 API 的 workers.dev 重新打开，
    //  使「只经自定义域对外服务」的约定静默失效，凭空多出一个公网入口。
    expect(
      parsed.workers_dev,
      `apps/${app} 缺省 workers_dev 会被 wrangler 每次部署默认开启，必须显式写 false`,
    ).toBe(false);
    expect(parsed.preview_urls, `apps/${app} 同样应显式关闭 preview_urls`).toBe(false);
  });

  it("`apps/api/wrangler.jsonc` 顶层绑定 `dshop-dev` 库——即自定义域实际服务的库", () => {
    // 与 docs/13 §13.7 同源：自定义域绑的是顶层 Worker，故顶层 `d1_databases` 就是线上库。
    const config = JSON.parse(stripJsonc(readFileSync(WRANGLER, "utf8"))) as {
      d1_databases?: { binding?: string; database_name?: string }[];
    };
    const top = config.d1_databases?.[0];
    expect(top?.binding).toBe("DB");
    expect(top?.database_name, "顶层库名变更须同步 docs/13 §13.7 的事实描述").toBe("dshop-dev");
  });
});

describe("自定义域纪律：必须声明在配置里，且不得被具名 env 继承抢走", () => {
  const APPS = ["api", "storefront", "admin"] as const;

  it.each(APPS)("`apps/%s/wrangler.jsonc` 把自定义域写进顶层 `routes`", (app) => {
    const raw = readFileSync(resolve(REPO_ROOT, `apps/${app}/wrangler.jsonc`), "utf8");
    const parsed = JSON.parse(stripJsonc(raw)) as WranglerConfig;
    // 为什么必须**显式声明**：自定义域原先只在账号状态里（Dashboard 绑定），
    // 用不带 `routes` 的配置部署时 wrangler 会打印 "No targets deployed"——
    // 域仍可达，但**无法从仓库复现**，新环境/新账号重建时必然漏掉。
    const patterns = (parsed.routes ?? []).map((r) => r.pattern);
    expect(patterns.length, `apps/${app} 必须显式声明自定义域`).toBeGreaterThan(0);
    for (const r of parsed.routes ?? []) {
      expect(r.custom_domain, `apps/${app} 的 ${r.pattern} 必须是 custom_domain`).toBe(true);
    }
  });

  it("具名 env 必须显式清空 `routes`，否则 `--env production` 会抢走线上域", () => {
    // wrangler 实测警告原文（node_modules/wrangler 内可检索到）：
    //   "The env.X environment inherits the top-level `routes` configuration,
    //    which includes the custom domain(s): ... Deploying this environment will
    //    reassign these custom domains away from the top-level Worker."
    // `api.eshop.eu.cc` 是 PiEcho 唯一依赖的域（docs/04 §3 P4），被抢走即 P0。
    const config = readWrangler();
    for (const [name, block] of Object.entries(config.env ?? {})) {
      expect(
        block.routes,
        `env.${name} 必须显式写 "routes": []，否则一次 --env ${name} 部署就会把顶层自定义域抢走`,
      ).toEqual([]);
    }
  });
});
