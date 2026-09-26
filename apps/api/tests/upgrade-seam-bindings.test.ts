/**
 * **升级缝绑定位的结构性锁**（`docs/04` §4.3 升级缝、`docs/12` §12.9 三条硬规则）。
 *
 * 本文件不测业务逻辑，只锁一条**架构纪律**：
 *
 * > 一条缝 = 一个绑定 = 一个开关。绑定缺省 → 默认实现；加绑定 → 仅该缝切升级实现；
 * > **删绑定 → 即刻回滚**。
 *
 * 为什么需要这层测试：纪律的脆弱点不在代码，而在**配置与类型的漂移**——
 * 只要 `wrangler.jsonc` 里的 binding 名与 `env.ts` 里的字段名有一个字母不一致，
 * 「加绑定即升级」就会静默失效（绑定加了、实现没切），而所有业务测试仍然全绿。
 *
 * 因此本文件解析 JSONC 到语义层再断言，并额外断言「默认配置里这些绑定**必须不存在**」
 * ——这是「删绑定即回滚」的配置侧证据。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const WRANGLER = resolve(REPO_ROOT, "apps/api/wrangler.jsonc");
const ENV_TS = resolve(REPO_ROOT, "apps/api/src/env.ts");

/**
 * 六条升级缝的**绑定位清单**——本表是「单一事实源」。
 *
 * - `binding`：`wrangler.jsonc` 里的绑定名（升级时取消注释的那个）。
 * - `envField`：`env.ts` 里对应的字段名。**必须与 `binding` 逐字一致**
 *   （业务代码从 `c.env.<field>` 读，wrangler 按 `binding` 注入）。
 * - `kind`：该绑定在 wrangler 配置里的字段名（用于定位到具体条目）。
 */
const SEAMS = [
  { seam: "S1", binding: "TASK_QUEUE", envField: "TASK_QUEUE", kind: "queues" },
  { seam: "S2", binding: "READ_DB", envField: "READ_DB", kind: "d1_databases" },
  { seam: "S5", binding: "PRODUCT_SEARCH", envField: "PRODUCT_SEARCH", kind: "vectorize" },
  { seam: "S6", binding: "MEDIA", envField: "MEDIA", kind: "r2_buckets" },
  { seam: "S7", binding: "CACHE_KV", envField: "CACHE_KV", kind: "kv_namespaces" },
  {
    seam: "S8",
    binding: "AGENT_RATE_LIMITER",
    envField: "AGENT_RATE_LIMITER",
    kind: "durable_objects",
  },
] as const;

/**
 * 去掉 JSONC 注释，返回可 `JSON.parse` 的文本。
 *
 * 用状态机而非逐行正则：正则方案在「升级指引改用块注释」或「字符串里出现 `//`」
 * 时会误判，锁的是字节而不是语义。
 */
function stripJsonComments(text: string): string {
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
  return stripTrailingCommas(out);
}

/**
 * 去掉 JSON 不允许的行尾逗号（JSONC 允许）。
 *
 * **必须字符串无感**：直接对整段文本做 `/,\s*[}\]]/` 替换会改写字符串内容——
 * 例如 `"vars": { "x": "a, }" }` 里的 `, }` 会被吞掉，解析结果与文件真实内容不一致
 * （静默改变语义，且当前配置里没有这种字符串，属于潜伏缺陷）。
 * 这里用与 `stripJsonComments` 同构的状态机，只在字符串区间**之外**删除逗号。
 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
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
    if (ch === ",") {
      // 向后跳过空白，确认是否紧跟 `}` 或 `]`（是则该逗号可删）
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
      const next = text[j];
      if (next === "}" || next === "]") continue;
    }
    out += ch;
  }
  return out;
}

/** 读入并解析 wrangler 配置到语义层。 */
function readWrangler(): Record<string, unknown> {
  return JSON.parse(stripJsonComments(readFileSync(WRANGLER, "utf8"))) as Record<string, unknown>;
}

/**
 * 取出某绑定类型下的**全部绑定名**。
 *
 * 关键点：不能只判断 `config[kind]` 是否存在——`d1_databases` 里合法地含有
 * 必需的主库 `DB` 绑定，S2 的升级绑定位 `READ_DB` 是**同一数组里的另一条**。
 * 因此必须深入到条目级，按绑定名判定。
 *
 * 兼容 wrangler 的两种形态：
 * - 数组形态（`d1_databases` / `vectorize` / `r2_buckets` / `kv_namespaces`）
 * - 对象形态（`queues: { producers, consumers }`、`durable_objects: { bindings }`）
 */
function bindingNames(config: Record<string, unknown>, kind: string): string[] {
  const node = config[kind];
  if (node === undefined || node === null) return [];

  const collect = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) return undefined;
        const record = entry as Record<string, unknown>;
        // 数组形态用 `binding`，DO 绑定用 `name`
        const name = record["binding"] ?? record["name"];
        return typeof name === "string" ? name : undefined;
      })
      .filter((name): name is string => name !== undefined);
  };

  if (Array.isArray(node)) return collect(node);
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    return [
      ...collect(record["producers"]),
      ...collect(record["consumers"]),
      ...collect(record["bindings"]),
    ];
  }
  return [];
}

describe("升级缝绑定位：默认配置必须零升级缝绑定（「删绑定即回滚」的配置侧证据）", () => {
  it("顶层只含必需的主库 DB，不含任何升级缝的绑定位", () => {
    const config = readWrangler();
    for (const { seam, binding, kind } of SEAMS) {
      // 按**绑定名**判定，而非按键是否存在（见 bindingNames 的注释）。
      // S8 的 durable_objects 与 S1 的 queues 尤其关键——它们是「付费/平台组件」。
      const names = bindingNames(config, kind);
      expect(names, `${seam} 的 ${kind}.${binding} 不应出现在默认配置里`).not.toContain(binding);
    }
    // 默认必须只剩主库这一个 D1 绑定
    expect(bindingNames(config, "d1_databases")).toEqual(["DB"]);
    // DO 迁移同样必须缺省（没有迁移就无从创建 DO 类）
    expect(config["migrations"]).toBeUndefined();
  });

  it("默认只保留免费层必需资源：D1 + 单一 Cron 入口", () => {
    const config = readWrangler();
    expect(config["d1_databases"]).toBeDefined();
    expect(config["triggers"]).toBeDefined();
    // 免费层额度：Cron 触发器 5 个/账户；此处只用 1 个（Cron 单一入口）
    const triggers = config["triggers"] as { crons?: unknown[] };
    expect(triggers.crons).toHaveLength(1);
  });

  it("**每一个**环境段同样零升级缝绑定（逐环境灰度不能变成逐环境默认升级）", () => {
    const config = readWrangler();
    const envs = (config["env"] ?? {}) as Record<string, Record<string, unknown>>;
    const names = Object.keys(envs);
    expect(names.length).toBeGreaterThanOrEqual(3); // preview / staging / production

    for (const name of names) {
      const block = envs[name] ?? {};
      for (const { seam, binding, kind } of SEAMS) {
        expect(bindingNames(block, kind), `env.${name} 的 ${seam} 不应默认绑定`).not.toContain(
          binding,
        );
      }
      expect(block["migrations"], `env.${name} 不应有 DO 迁移`).toBeUndefined();
      // 但每个环境**必须**显式声明自己的 DB（wrangler 的 env 段不继承 d1_databases）
      expect(bindingNames(block, "d1_databases"), `env.${name} 必须声明 d1_databases`).toEqual([
        "DB",
      ]);
    }
  });
});

describe("升级缝绑定位：升级指引必须保留（「加绑定即升级」可操作性）", () => {
  it("每条缝都在配置注释里给出绑定名与目标资源字段", () => {
    const raw = readFileSync(WRANGLER, "utf8");
    for (const { seam, binding, kind } of SEAMS) {
      expect(raw, `${seam} 的绑定名 ${binding} 未出现在配置中`).toContain(binding);
      expect(raw, `${seam} 的绑定类型 ${kind} 未出现在配置中`).toContain(kind);
    }
  });

  it("S8 的 DO 类名与迁移 tag 被保留（升级时可直接取消注释）", () => {
    const raw = readFileSync(WRANGLER, "utf8");
    expect(raw).toContain("AgentRateLimiter");
    expect(raw).toContain("new_sqlite_classes");
  });
});

describe("升级缝绑定位：env.ts 的字段名与配置绑定名逐字一致", () => {
  it("每条缝在 env.ts 里都是**可选**绑定（`?`），业务代码禁止依赖其存在", () => {
    const raw = readFileSync(ENV_TS, "utf8");
    for (const { seam, envField } of SEAMS) {
      // 必须是 `readonly X?: T` 形式
      const optional = new RegExp(`readonly\\s+${envField}\\?\\s*:`);
      expect(raw, `${seam} 的 ${envField} 必须是可选绑定`).toMatch(optional);
      // 反证：不能是必需绑定（`readonly X: T` 或 `X: T`）
      const required = new RegExp(`(readonly\\s+)?${envField}\\s*:\\s*[A-Z]`);
      expect(raw, `${seam} 的 ${envField} 不能是必需绑定`).not.toMatch(required);
    }
  });

  it("每条缝在 env.ts 里都带「升级缝」纪律注释（说明缺省/升级/开关方式）", () => {
    const raw = readFileSync(ENV_TS, "utf8");
    for (const { seam, envField } of SEAMS) {
      const idx = raw.indexOf(envField);
      expect(idx, `${envField} 未找到`).toBeGreaterThan(-1);
      // 取该字段前 800 字符作为其文档块
      const docblock = raw.slice(Math.max(0, idx - 800), idx);
      expect(docblock, `${envField} 缺少「${seam} 升级缝」标注`).toContain(seam);
      expect(docblock, `${envField} 未说明缺省行为`).toContain("缺省");
    }
  });
});

describe("升级缝纪律：多环境段的语义（「单缝 × 单环境」而非「两套预设」）", () => {
  it("不存在全局模式位（纪律明令禁止全局开关）", () => {
    const raw = readFileSync(WRANGLER, "utf8");
    const flat = JSON.stringify(readWrangler());
    for (const forbidden of ["PAID", "PAID_MODE", "UPGRADE_ALL", "IS_PAID"]) {
      expect(flat, `不应存在全局模式位 ${forbidden}`).not.toContain(forbidden);
    }
    // 且配置里明确写了「不存在免费/付费两套预设」这条纪律
    expect(raw).toContain("不存在");
  });

  it("三个环境的名字互不相同（wrangler 要求 env.name 唯一）", () => {
    const envs = (readWrangler()["env"] ?? {}) as Record<string, { name?: string }>;
    const names = Object.values(envs).map((e) => e.name);
    expect(names.every((n) => typeof n === "string" && n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * 扫描 JSONC 文本里的**重复键**（`JSON.parse` 会静默让后者覆盖前者）。
 *
 * 为什么必须自己扫：`JSON.parse` 对重复键**不报错**，只是后者胜出。于是
 * 「按升级指引取消注释一段 `"d1_databases": [...]`」会得到两个同名顶层键——
 * 生效的仍是旧的那个，升级**静默无效**，而所有 `JSON.parse` 派生的断言照样通过。
 * 这是本文件最需要防住的一类漂移。
 *
 * 返回形如 `["d1_databases"]` 的键名列表（空数组 = 无重复）。
 */
function findDuplicateKeys(text: string): string[] {
  const duplicates: string[] = [];
  // 作用域栈：`{` 压入一个 Set（记录已见键）；`[` 压入 null（数组元素不判重）。
  const scopes: (Set<string> | null)[] = [];
  let inString = false;
  let escaped = false;
  /** 刚读完的字符串内容（可能是键，也可能是值）。 */
  let lastString: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
        lastString = (lastString ?? "") + ch;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      } else {
        lastString = (lastString ?? "") + ch;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      lastString = "";
      continue;
    }
    if (ch === ":") {
      // 紧跟在字符串之后的冒号 ⇒ 该字符串是键
      if (lastString !== null) {
        const scope = scopes[scopes.length - 1];
        if (scope) {
          if (scope.has(lastString)) duplicates.push(lastString);
          else scope.add(lastString);
        }
      }
      lastString = null;
      continue;
    }
    if (ch === "{") {
      scopes.push(new Set<string>());
      lastString = null;
      continue;
    }
    if (ch === "[") {
      scopes.push(null);
      lastString = null;
      continue;
    }
    if (ch === "}" || ch === "]") {
      scopes.pop();
      lastString = null;
      continue;
    }
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === ",") continue;
    // 其它字符（数字、true/false/null）结束当前字符串的「键」身份
    lastString = null;
  }
  return duplicates;
}

describe("升级缝纪律：配置的**结构完整性**（防静默漂移）", () => {
  it("JSONC 里**没有重复键**（重复键会让升级静默无效）", () => {
    const duplicates = findDuplicateKeys(stripJsonComments(readFileSync(WRANGLER, "utf8")));
    expect(duplicates, `发现重复键：${duplicates.join(", ")}`).toEqual([]);
  });

  it("任一 `env.*.name` 都**不等于**顶层 `name`（否则 dev 与生产是同一个 Worker）", () => {
    const config = readWrangler();
    const topName = config["name"];
    expect(typeof topName).toBe("string");
    const envs = (config["env"] ?? {}) as Record<string, { name?: string }>;
    for (const [envName, block] of Object.entries(envs)) {
      expect(
        block.name,
        `env.${envName}.name 与顶层 name 相同（"${String(topName)}"），会部署到同一个 Worker`,
      ).not.toBe(topName);
    }
  });

  it("任何 `vars` 键都**不得**与升级缝的绑定名同名（否则运行时拿到字符串而非绑定对象）", () => {
    const config = readWrangler();
    const bindingNamesAll = SEAMS.map((s) => s.binding);
    const scopes: Record<string, unknown>[] = [
      config,
      ...Object.values((config["env"] ?? {}) as Record<string, Record<string, unknown>>),
    ];
    for (const scope of scopes) {
      const vars = (scope["vars"] ?? {}) as Record<string, unknown>;
      for (const binding of bindingNamesAll) {
        expect(
          Object.keys(vars),
          `vars 里出现了绑定名 ${binding}：运行时它会是字符串，导致 "is not a function"`,
        ).not.toContain(binding);
      }
    }
  });

  it("每个环境段都声明了非空 `name`", () => {
    const envs = (readWrangler()["env"] ?? {}) as Record<string, { name?: string }>;
    for (const [envName, block] of Object.entries(envs)) {
      expect(typeof block.name, `env.${envName} 缺少 name`).toBe("string");
      expect((block.name ?? "").length).toBeGreaterThan(0);
    }
  });
});

describe("升级缝纪律：JSONC 预处理必须**字符串无感**（复核 P2-5）", () => {
  it("★ 字符串内的 `, }` / `, ]` 不被吞掉（否则解析结果与文件不一致）", () => {
    const src = `{
  "vars": { "x": "a, }", "y": "b, ]", "z": "c,  }" },
  "list": [1, 2,],
}`;
    const parsed = JSON.parse(stripTrailingCommas(src)) as {
      vars: Record<string, string>;
      list: number[];
    };
    // 行尾逗号被去掉（JSON 可解析）
    expect(parsed.list).toEqual([1, 2]);
    // 字符串内容原样保留 —— 这是本用例的核心断言
    expect(parsed.vars["x"]).toBe("a, }");
    expect(parsed.vars["y"]).toBe("b, ]");
    expect(parsed.vars["z"]).toBe("c,  }");
  });

  it("★ 转义引号不会让状态机误判字符串边界", () => {
    const src = `{"a": "he said \\"x, }\\" ok", "b": 1,}`;
    const parsed = JSON.parse(stripTrailingCommas(src)) as { a: string; b: number };
    expect(parsed.a).toBe('he said "x, }" ok');
    expect(parsed.b).toBe(1);
  });
});
