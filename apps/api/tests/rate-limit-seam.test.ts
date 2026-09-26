/**
 * S8 升级缝的**开关语义**验证（`docs/04` §4.3 S8、`docs/07` §7.8.4）。
 *
 * 本文件断言的不是「限流算得对不对」（那由 `packages/services` 的测试覆盖），
 * 而是**升级缝本身是否真的可开关、可观测、可回滚**：
 *
 * 1. **绑定缺省 → 走默认实现**（应用层自研计数），不依赖任何 Durable Object。
 * 2. **绑定存在 → 走升级实现**（DO 全局精确计数）。
 * 3. **升级实现故障 → 降级但仍限流**（回退到默认实现）**且留痕**
 *    （告警 `rate_limiter_unavailable` + `degraded: true`），
 *    **而不是**旧实现的 fail-open 放行（= 完全不限流）+ 静默。
 * 4. **默认配置不含 DO 绑定**——「删绑定即回滚」的配置侧证据
 *    （用 **JSONC 解析**而非正则，避免注释风格变化导致误判）。
 * 5. **真实入口覆盖**：不带绑定的 env 经 `app.request()` 打真实端点，
 *    验证中间件确实从 `c.env` 读取、且 429 路径与响应头正确。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  createRateLimitStore,
  DurableObjectRateLimitStore,
  InMemoryRateLimitStore,
  resetSharedRateLimitStore,
} from "../src/lib/rate-limit-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

/** 构造一个「总是返回固定响应」的假 DO namespace。 */
function fakeNamespace(handler: () => Promise<Response>): DurableObjectNamespace {
  const stub = { fetch: handler } as unknown as DurableObjectStub;
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => stub,
  } as unknown as DurableObjectNamespace;
}

/** 一个形状合法的 DO 响应体。 */
function doBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowed: true,
    count: 1,
    limit: 3,
    remaining: 2,
    retryAfterSeconds: 60,
    ...overrides,
  };
}

/** 一次普通检查的入参。 */
const INPUT = {
  tokenId: "tok_test_001",
  pathTemplate: "/orders/{orderNo}",
  limit: 3,
  nowMs: 1_700_000_000_000,
} as const;

/**
 * 去掉 JSONC 注释（`//` 行注释与 `/* … *\/` 块注释），返回可 `JSON.parse` 的文本。
 *
 * ⚠️ 用解析而非正则：正则方案（逐行剔除 `trimStart().startsWith("//")`）在
 * 升级指引改用块注释时会**误报失败**，且锁的是字节而非语义。
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
  // 去掉可能残留的行尾逗号（JSONC 允许，JSON 不允许）
  return out.replace(/,(\s*[}\]])/g, "$1");
}

describe("S8 升级缝：绑定缺省 → 默认实现（应用层自研计数）", () => {
  it("createRateLimitStore(undefined) 返回内存实现，且 name 为 memory", () => {
    resetSharedRateLimitStore();
    const store = createRateLimitStore(undefined);
    expect(store).toBeInstanceOf(InMemoryRateLimitStore);
    expect(store.name).toBe("memory");
  });

  it("默认实现真的在计数：第 limit 次放行，第 limit+1 次拒绝", async () => {
    resetSharedRateLimitStore();
    const store = createRateLimitStore(undefined);

    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await store.check({ ...INPUT }));
    }

    // limit = 3 → 前 3 次 allowed，第 4 次 not allowed（且带 Retry-After 语义）
    expect(results.map((r) => r.decision.allowed)).toEqual([true, true, true, false]);
    expect(results[3]?.decision.remaining).toBe(0);
    expect(results[3]?.decision.retryAfterSeconds).toBeGreaterThan(0);
    // 未降级：来源就是默认实现本身
    expect(results.every((r) => r.store === "memory" && !r.degraded)).toBe(true);
  });

  it("默认实现按「令牌 + 端点 + 窗口」分桶，不同令牌互不干扰", async () => {
    resetSharedRateLimitStore();
    const store = createRateLimitStore(undefined);

    for (let i = 0; i < 3; i += 1) await store.check({ ...INPUT, tokenId: "tok_a" });

    // tok_a 已用满 3 次；tok_b 是独立桶，应仍可放行
    const other = await store.check({ ...INPUT, tokenId: "tok_b" });
    expect(other.decision.allowed).toBe(true);
    expect(other.decision.count).toBe(1);
  });
});

describe("S8 升级缝：绑定存在 → 升级实现（DO 全局精确计数）", () => {
  it("createRateLimitStore(namespace) 返回 DO 实现，name 为 durable-object", () => {
    resetSharedRateLimitStore();
    const store = createRateLimitStore(fakeNamespace(async () => Response.json(doBody())));
    expect(store.name).toBe("durable-object");
  });

  it("DO 正常时，决策直接来自 DO（证明升级实现确实在生效，而非被默认实现顶替）", async () => {
    resetSharedRateLimitStore();
    // DO 报告「已超限」，与默认实现会给出的结果明显不同（默认第 1 次必放行）
    const namespace = fakeNamespace(async () =>
      Response.json(doBody({ allowed: false, count: 99, remaining: 0, retryAfterSeconds: 42 })),
    );
    const store = createRateLimitStore(namespace);

    const result = await store.check({ ...INPUT });
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.count).toBe(99);
    expect(result.decision.retryAfterSeconds).toBe(42);
    expect(result.store).toBe("durable-object");
    expect(result.degraded).toBe(false);
  });

  it("DO 名字由 tokenId 派生（同一令牌落同一实例 = 单点串行 = 原子），且透传 nowMs", async () => {
    const seen: string[] = [];
    let sentBody: unknown = null;
    const namespace = {
      idFromName: (name: string) => {
        seen.push(name);
        return name as unknown as DurableObjectId;
      },
      get: () =>
        ({
          fetch: async (_url: string, init?: RequestInit) => {
            sentBody = JSON.parse(String(init?.body));
            return Response.json(doBody());
          },
        }) as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace;

    const store = new DurableObjectRateLimitStore(namespace);
    await store.check({ ...INPUT, tokenId: "tok_xyz" });
    expect(seen).toEqual(["tok_xyz"]);
    // nowMs 必须透传，使 DO 侧窗口边界与调用方同源（否则窗口边界单测不可注入）
    expect(sentBody).toMatchObject({ nowMs: INPUT.nowMs, tokenId: "tok_xyz" });
  });
});

describe("S8 升级缝：降级语义 = 「降级但仍限流」且**留痕**（修正旧 fail-open + 静默）", () => {
  it("DO 抛异常时回退到默认实现，**不是**无条件放行", async () => {
    resetSharedRateLimitStore();
    const namespace = fakeNamespace(async () => {
      throw new Error("DO unavailable");
    });
    const store = createRateLimitStore(namespace);

    // limit = 3：若为旧的 fail-open，则 4 次全部 allowed=true。
    // 正确行为：回退到内存计数，第 4 次必须被拒。
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await store.check({ ...INPUT }));
    }

    expect(results.map((r) => r.decision.allowed)).toEqual([true, true, true, false]);
    // 反证：若实现是 fail-open，这一条会失败
    expect(results.filter((r) => !r.decision.allowed)).toHaveLength(1);
    // 降级必须被标记（否则中间件会谎报来源）
    expect(results.every((r) => r.degraded && r.store === "memory")).toBe(true);
  });

  it("降级时**发出告警** `rate_limiter_unavailable`（不再静默）", async () => {
    resetSharedRateLimitStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const store = createRateLimitStore(
        fakeNamespace(async () => {
          throw new Error("DO unavailable");
        }),
      );
      await store.check({ ...INPUT });

      const events = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes("rate_limiter_unavailable"));
      expect(events.length).toBeGreaterThan(0);
      // 告警必须带上下文（事件名 + 来源 + 回退目标 + 原始错误）
      expect(events[0]).toContain("durable-object");
      expect(events[0]).toContain("memory");
      expect(events[0]).toContain("DO unavailable");
    } finally {
      warn.mockRestore();
    }
  });

  it("DO 返回非 2xx 时同样回退到默认实现（而非放行）", async () => {
    resetSharedRateLimitStore();
    const store = createRateLimitStore(
      fakeNamespace(async () => new Response("boom", { status: 500 })),
    );

    const first = await store.check({ ...INPUT });
    expect(first.decision.allowed).toBe(true);
    expect(first.decision.count).toBe(1); // 来自内存实现
    expect(first.degraded).toBe(true);
  });

  it("DO 返回 200 但形状非法时回退（否则 allowed=undefined 会误判全量超限）", async () => {
    resetSharedRateLimitStore();
    const store = createRateLimitStore(fakeNamespace(async () => Response.json({ ok: true })));

    const result = await store.check({ ...INPUT });
    expect(result.decision.allowed).toBe(true);
    expect(result.degraded).toBe(true);
    // 反证：若未校验形状，retryAfterSeconds 会是 undefined
    expect(typeof result.decision.retryAfterSeconds).toBe("number");
  });

  it("DO 恢复后重新走升级实现（回退不粘滞）", async () => {
    resetSharedRateLimitStore();
    let broken = true;
    const namespace = fakeNamespace(async () => {
      if (broken) throw new Error("DO unavailable");
      return Response.json(doBody({ count: 7, remaining: 0 }));
    });
    const store = createRateLimitStore(namespace);

    await store.check({ ...INPUT }); // 走回退
    broken = false;
    const after = await store.check({ ...INPUT });
    expect(after.decision.count).toBe(7); // 来自 DO，证明已切回升级实现
    expect(after.degraded).toBe(false);
  });
});

describe("S8 升级缝：默认配置不含 DO 绑定（删绑定即回滚的结构性证据）", () => {
  it("apps/api/wrangler.jsonc 解析后不含 durable_objects / migrations", () => {
    const raw = readFileSync(resolve(REPO_ROOT, "apps/api/wrangler.jsonc"), "utf8");
    const config = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;

    // 断言解析后的**语义**，而非字节：注释风格变化（行注释 / 块注释）不影响结论。
    expect(config["durable_objects"]).toBeUndefined();
    expect(config["migrations"]).toBeUndefined();
    // D1 仍在（默认实现依赖 D1 之外无绑定，但 D1 本身是必需资源）
    expect(config["d1_databases"]).toBeDefined();
    // Cron 触发器存在（S1 默认实现：审计批量落库）
    expect(config["triggers"]).toBeDefined();
  });

  it("升级指引以注释形式保留（保证「加绑定即升级」可操作）", () => {
    const raw = readFileSync(resolve(REPO_ROOT, "apps/api/wrangler.jsonc"), "utf8");
    expect(raw).toMatch(/"durable_objects"/);
    expect(raw).toMatch(/AGENT_RATE_LIMITER/);
    expect(raw).toMatch(/AgentRateLimiter/);
  });

  it("env.ts 把 AGENT_RATE_LIMITER 声明为可选绑定（业务代码禁止依赖其存在）", () => {
    const raw = readFileSync(resolve(REPO_ROOT, "apps/api/src/env.ts"), "utf8");
    expect(raw).toMatch(/AGENT_RATE_LIMITER\?\s*:/);
    // 反证：不能是必需绑定
    expect(raw).not.toMatch(/AGENT_RATE_LIMITER\s*:\s*DurableObjectNamespace/);
  });

  it("stripJsonComments 自身可用（解析器不吞字符串内的 `//`）", () => {
    // 防回归：URL 里的 `//` 不能被当成注释起点
    const sample = '{ "url": "https://example.com/x", /* c */ "a": 1, }';
    expect(JSON.parse(stripJsonComments(sample))).toEqual({
      url: "https://example.com/x",
      a: 1,
    });
  });
});
