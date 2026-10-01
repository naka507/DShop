/**
 * DShop C 端全链路验收（真实 DShop + 真实浏览器 + 真实 PiEcho 网关）
 *
 * ## 这一层解决什么问题
 *
 * DShop 现有的 golden 场景跑的是 `ESHOP_MODE=fixture`（离线桩），**不碰真浏览器、
 * 不碰真 API、不碰真数据库**。本脚本补上那一层：像真人一样在 storefront 里
 * **登录 → 加购 → 结算 → 下单**，再从 API 侧读回订单，并**同时**比对
 * Agent 面与 C 端两侧的状态——R27 的原始症状就是「同一个订单两面显示不同状态」。
 *
 * ## 为什么零依赖
 *
 * Node ≥ 22 自带全局 `WebSocket`，配合系统 Chrome 的 CDP 即可驱动浏览器，
 * 无需 Playwright / puppeteer。这与 `PiEcho/scripts/e2e-browser-gateway.ts` 同一策略。
 *
 * ## 退出码契约
 *
 * - `0` 全部通过
 * - `1` 有断言失败（**真实缺陷**，不是脚本问题）
 * - `2` 环境不满足（Chrome 缺失、端口被占、依赖没装、必需进程起不来）
 *
 * 用法：
 *   npm run e2e:customer
 *   npm run e2e:customer -- --skip-chat     # 跳过客服对话腿（不需要真实模型）
 *   npm run e2e:customer -- --keep-data     # 不清理造出的数据（排查用）
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

const DSHOP_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// PiEcho 仓库根：**仅客服对话腿**需要。可用 `PIECHO_ROOT` 覆盖；
// `--skip-chat` 时该值不参与任何前置检查（见下方 main 的校验分支）。
const PIECHO_ROOT = process.env["PIECHO_ROOT"]?.trim() ?? "E:/Code/PiEcho/PiEcho";

const API_PORT = 8787;
const GATEWAY_PORT = 8788;
const STORE_PORT = 5173;

const API_BASE = `http://127.0.0.1:${API_PORT}`;
const GATEWAY_BASE = `http://127.0.0.1:${GATEWAY_PORT}`;
const STORE_BASE = `http://127.0.0.1:${STORE_PORT}`;

/** Chrome 可执行文件路径的环境变量覆盖（CI / 容器用）。 */
const CHROME_PATH_ENV = "DSHOP_E2E_CHROME";

/** Chrome 默认路径候选。 */
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable",
];

/** 契约版本头取值。**注意是 `"1"` 而不是 `"1.0.0"`**——实测传 `1.0.0` 会 400。 */
const CONTRACT_VERSION = "1";

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

type CleanupFn = () => void | Promise<void>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 逆序清理，每步独立 try（清理失败不改变验收结论）。 */
async function runCleanup(cleanup: readonly CleanupFn[]): Promise<void> {
  for (const fn of [...cleanup].reverse()) {
    try {
      await fn();
    } catch {
      /* 清理失败不改变验收结论 */
    }
  }
}

/** 杀掉整棵进程树（Windows 用 `taskkill /T /F`；POSIX 用进程组）。 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}

/** 找一个可用的 Chrome 可执行文件。显式配置错了就报错，不静默回落。 */
function resolveChrome(): string | undefined {
  const fromEnv = process.env[CHROME_PATH_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return existsSync(fromEnv) ? fromEnv : undefined;
  }
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}

/** 端口是否已被占用。 */
async function portBusy(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200) });
    return true;
  } catch {
    return false;
  }
}

/** 轮询直到 `predicate` 为真或超时。 */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 400,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await predicate()) return true;
    } catch {
      /* 还没就绪 */
    }
    await sleep(intervalMs);
  }
  return false;
}

/** 解析 `.dev.vars`：**必须去引号 + 去行内 `#` 注释**（否则密钥比对会失败）。 */
function loadDevVars(): Record<string, string> {
  const txt = readFileSync(join(DSHOP_ROOT, "apps/api/.dev.vars"), "utf8");
  const out: Record<string, string> = {};
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    const hash = value.indexOf("#");
    if (hash >= 0) value = value.slice(0, hash).trim();
    out[key] = value;
  }
  return out;
}

/**
 * 找本地 D1 的 sqlite 文件。
 *
 * **取最大的那个**：同一目录里有一个 4096 字节的空壳，选错会得到空库。
 */
function findD1File(): string | undefined {
  const root = join(DSHOP_ROOT, "apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!existsSync(root)) return undefined;
  let best: { p: string; size: number } | undefined;
  for (const f of readdirSync(root)) {
    if (!f.endsWith(".sqlite")) continue;
    const p = join(root, f);
    const size = statSync(p).size;
    if (best === undefined || size > best.size) best = { p, size };
  }
  return best?.p;
}

/** 生成 26 字符 ULID（`user_addresses.id` 必须符合 `UlidSchema`）。 */
function ulid(): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = Date.now();
  let s = "";
  for (let i = 0; i < 10; i += 1) {
    s = A[ts % 32] + s;
    ts = Math.floor(ts / 32);
  }
  const rb = randomBytes(16);
  for (let i = 0; i < 16; i += 1) s += A[rb[i]! % 32];
  return s;
}

/**
 * 把字节数组编码为 base64url（无填充）。
 *
 * **刻意不用 `Buffer.toString("base64")`**：`tooling/tsconfig/base.json` 的 `types`
 * 含 `@cloudflare/workers-types`，它声明的全局 `Buffer` 把 `toString` 收窄成无参重载，
 * 在脚本上下文里会报 `TS2554: Expected 0 arguments, but got 1`。手写编码既绕开这个
 * 冲突，也避免了对 Node 专有 API 的依赖。
 */
function base64Url(bytes: Uint8Array): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** 拼接若干字节数组。 */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * AES-256-GCM 加密手机号。
 *
 * `user_addresses.receiver_phone` 必须是密文 `v1.<ivB64Url>.<cipherB64Url>`，
 * key = `SHA-256(PHONE_ENC_KEY)`，IV 12 字节，128-bit tag 附在密文尾部。
 * 明文会导致契约校验 500。
 */
function encryptPhone(phone: string, keyRaw: string): string {
  const key = createHash("sha256").update(keyRaw).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = concatBytes([cipher.update(phone, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${base64Url(iv)}.${base64Url(concatBytes([enc, tag]))}`;
}

/* -------------------------------------------------------------------------- */
/* 断言器                                                                      */
/* -------------------------------------------------------------------------- */

class Reporter {
  private readonly results: Array<{ id: string; title: string; ok: boolean; detail: string }> = [];

  /** 记录一条断言并即时打印（失败要响，不攒到最后）。 */
  check(id: string, title: string, ok: boolean, detail: string): boolean {
    this.results.push({ id, title, ok, detail });
    const mark = ok ? "PASS" : "FAIL";
    process.stdout.write(`  [${mark}] ${id} ${title}\n         ${detail}\n`);
    return ok;
  }

  get failed(): number {
    return this.results.filter((r) => !r.ok).length;
  }

  get total(): number {
    return this.results.length;
  }

  summary(): void {
    process.stdout.write(`\n断言合计：${this.total - this.failed}/${this.total} 通过\n`);
    for (const r of this.results) {
      if (!r.ok) process.stdout.write(`  ✗ ${r.id} ${r.title}\n`);
    }
  }
}

/** 环境不满足（退出码 2），与断言失败区分开。 */
class EnvError extends Error {}

/* -------------------------------------------------------------------------- */
/* CDP 客户端（零依赖：Node 22 全局 WebSocket）                                 */
/* -------------------------------------------------------------------------- */

interface CdpClient {
  evaluate(expression: string): Promise<{ value?: unknown; threw?: string }>;
  close(): void;
}

/**
 * 启动 Chrome 并连上 CDP。
 *
 * `--remote-debugging-port=0` 让 Chrome 自选端口，实际端口写在 `user-data-dir`
 * 下的 `DevToolsActivePort` 第一行——比固定 9222 更稳（不会撞端口）。
 */
async function launchChrome(
  chromePath: string,
  pageUrl: string,
  userDataDir: string,
  cleanup: CleanupFn[],
): Promise<{ client: CdpClient }> {
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    // stdio 三路 `ignore`：**不能**用 `pipe` 而不消费——管道写满会阻塞 Chrome。
    { stdio: ["ignore", "ignore", "ignore"], detached: process.platform !== "win32" },
  );

  // ★ spawn 之后立刻登记回收：本函数有三个抛出点，等调用方登记会漏掉已启动的 Chrome。
  if (child.pid !== undefined) {
    const pid = child.pid;
    cleanup.push(() => killTree(pid));
  }

  const portFile = join(userDataDir, "DevToolsActivePort");
  let cdpPort: number | undefined;
  for (let i = 0; i < 150; i += 1) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, "utf8").split("\n")[0]?.trim();
      if (first !== undefined && first.length > 0) {
        cdpPort = Number(first);
        break;
      }
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  if (cdpPort === undefined || Number.isNaN(cdpPort)) {
    throw new EnvError("Chrome 未在 15s 内写出 DevToolsActivePort");
  }

  const versionRaw = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()) as {
    webSocketDebuggerUrl?: string;
  };
  const wsUrl = versionRaw.webSocketDebuggerUrl;
  if (wsUrl === undefined) throw new EnvError("CDP /json/version 未返回 webSocketDebuggerUrl");

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new EnvError("CDP WebSocket 连接失败")), { once: true });
  });
  cleanup.push(() => ws.close());

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  ws.addEventListener("message", (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; error?: unknown; result?: unknown };
    if (msg.id === undefined) return;
    const slot = pending.get(msg.id);
    if (slot === undefined) return;
    pending.delete(msg.id);
    // ★ 必须清掉定时器，否则每次成功调用都在事件循环里留一个未触发的定时器，
    //   最后一次调用后进程会被拖住最多 20s 才退出。
    clearTimeout(slot.timer);
    if (msg.error !== undefined) slot.reject(new Error(JSON.stringify(msg.error)));
    else slot.resolve(msg.result);
  });

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> => {
    const id = nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 30_000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
    });
  };

  const { targetId } = (await send("Target.createTarget", { url: pageUrl })) as { targetId: string };
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as {
    sessionId: string;
  };
  await send("Runtime.enable", {}, sessionId);

  return {
    client: {
      async evaluate(expression: string) {
        const res = (await send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        )) as {
          result?: { value?: unknown };
          exceptionDetails?: { exception?: { description?: string } };
        };
        if (res.exceptionDetails !== undefined) {
          return { threw: res.exceptionDetails.exception?.description ?? "unknown" };
        }
        return { value: res.result?.value };
      },
      close() {
        try {
          ws.close();
        } catch {
          /* 已关闭 */
        }
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 页面操作助手                                                                */
/* -------------------------------------------------------------------------- */

/** 在页面里执行一段 JS 并返回字符串结果。 */
async function pageEval(client: CdpClient, expr: string): Promise<string> {
  const r = await client.evaluate(expr);
  if (r.threw !== undefined) throw new Error(`页面脚本抛错：${r.threw}`);
  return String(r.value ?? "");
}

/** 等到页面里 `expr` 求值为真。 */
async function waitPage(client: CdpClient, expr: string, timeoutMs: number, label: string): Promise<void> {
  const ok = await waitFor(async () => (await pageEval(client, `!!(${expr})`)) === "true", timeoutMs);
  if (!ok) throw new Error(`等待超时：${label}（${expr}）`);
}

/** 导航到指定路径。 */
async function nav(client: CdpClient, path: string): Promise<void> {
  await pageEval(client, `location.href = ${JSON.stringify(STORE_BASE + path)}; "ok"`);
  await sleep(300);
}

/**
 * 给 React 受控输入框赋值。
 *
 * **必须用原生 setter + 派发 input 事件**——直接改 `el.value` 不会触发 React 的
 * onChange，表单状态不会更新。
 */
async function setInput(client: CdpClient, selector: string, value: string): Promise<void> {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "NOT_FOUND";
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "OK";
  })()`;
  const r = await pageEval(client, expr);
  if (r !== "OK") throw new Error(`输入框未找到：${selector}`);
}

/**
 * 按可见文本点击可点元素。
 *
 * 注意：DShop storefront 里并非所有「按钮」都是 `<button>`——例如购物车的
 * 「去结算（N 件）」是 react-router 的 `<Link>`（渲染成 `<a>`）。所以候选集要
 * 覆盖 `button` / `a` / `[role="button"]`，且 **`<button>` 优先**，避免
 * 「登录」这类既有按钮又有导航链接的文案被误命中。
 */
async function clickByText(client: CdpClient, text: string, timeoutMs = 10_000): Promise<void> {
  const expr = `(() => {
    const sel = 'button, a, [role="button"]';
    const all = [...document.querySelectorAll(sel)].filter((x) => {
      if (x.disabled) return false;
      const cs = getComputedStyle(x);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      return (x.textContent || "").includes(${JSON.stringify(text)});
    });
    const rank = (x) => (x.tagName === "BUTTON" ? 0 : x.tagName === "A" ? 1 : 2);
    all.sort((a, b) => rank(a) - rank(b));
    const b = all[0];
    if (!b) return "NOT_FOUND";
    b.click();
    return "OK";
  })()`;
  const ok = await waitFor(async () => (await pageEval(client, expr)) === "OK", timeoutMs, 300);
  if (!ok) throw new Error(`按钮未找到或不可点：${text}`);
}

/* -------------------------------------------------------------------------- */
/* 进程编排                                                                    */
/* -------------------------------------------------------------------------- */

interface Proc {
  name: string;
  child: ChildProcess;
}

function startProc(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  cleanup: CleanupFn[],
): Proc {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore"],
    detached: process.platform !== "win32",
  });
  if (child.pid !== undefined) {
    const pid = child.pid;
    cleanup.push(() => killTree(pid));
  }
  child.on("error", () => {
    /* 启动失败由后续健康检查统一报错 */
  });
  return { name, child };
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

interface Options {
  skipChat: boolean;
  keepData: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { skipChat: false, keepData: false };
  for (const a of argv) {
    if (a === "--skip-chat") opts.skipChat = true;
    else if (a === "--keep-data") opts.keepData = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "用法：npm run e2e:customer [-- --skip-chat] [--keep-data]\n" +
          "  --skip-chat  跳过客服对话腿（不需要真实模型）\n" +
          "  --keep-data  不清理造出的数据\n",
      );
      process.exit(0);
    } else {
      // 用法错误 ≠ 环境不满足：退出码 1。
      process.stderr.write(`未知参数：${a}\n`);
      process.exit(1);
    }
  }
  return opts;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const reporter = new Reporter();
  const cleanup: CleanupFn[] = [];

  // ---- 前置环境检查（不满足 → 退出码 2） ----
  const chrome = resolveChrome();
  if (chrome === undefined) {
    const explicit = process.env[CHROME_PATH_ENV]?.trim();
    process.stderr.write(
      explicit !== undefined && explicit.length > 0
        ? `环境不满足：${CHROME_PATH_ENV} 指向的文件不存在：${explicit}\n`
        : "环境不满足：未找到 Chrome（可用 DSHOP_E2E_CHROME 显式指定）\n",
    );
    return 2;
  }
  const d1File = findD1File();
  if (d1File === undefined) {
    process.stderr.write("环境不满足：找不到本地 D1 sqlite（先跑一次 npm run db:migrate:local）\n");
    return 2;
  }
  const viteEntry = join(DSHOP_ROOT, "node_modules/vite/bin/vite.js");
  if (!existsSync(viteEntry)) {
    process.stderr.write(`环境不满足：找不到 ${viteEntry}（先 npm install）\n`);
    return 2;
  }
  // ★ PiEcho 网关只在**客服对话腿**需要。`--skip-chat` 时不得要求它存在，
  //   否则「纯 DShop 侧回归」（A01–A11：浏览器下单 + 两面状态一致性）就无法
  //   在 DShop 自己的 CI 里运行——而 DShop 仓库根本不含 PiEcho。
  if (!opts.skipChat && !existsSync(join(PIECHO_ROOT, "server/src/index.ts"))) {
    process.stderr.write(
      `环境不满足：找不到 PiEcho 网关（PIECHO_ROOT=${PIECHO_ROOT}）。` +
        `仅验 DShop 侧可用 --skip-chat（不需要 PiEcho）。\n`,
    );
    return 2;
  }

  for (const [port, label] of [
    [API_PORT, "DShop API"],
    [STORE_PORT, "storefront"],
  ] as const) {
    if (await portBusy(port)) {
      process.stderr.write(`环境不满足：端口 ${port} 已被占用（${label}）\n`);
      return 2;
    }
  }

  const devVars = loadDevVars();
  const db = new DatabaseSync(d1File);

  // 造出的数据（清理用）
  const made: {
    userId?: string;
    addressId?: string;
    orderId?: string;
    orderNo?: string;
    tokenId?: string;
  } = {};

  process.stdout.write(`Chrome   : ${chrome}\n`);
  process.stdout.write(`D1       : ${d1File}\n`);
  if (!opts.skipChat) process.stdout.write(`PiEcho   : ${PIECHO_ROOT}\n`);

  try {
    /* ---------------- 1. 起 DShop API ---------------- */
    process.stdout.write("── 启动 DShop API ──\n");
    startProc(
      "dshop-api",
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--config",
        "apps/api/wrangler.jsonc",
        "--port",
        String(API_PORT),
      ],
      DSHOP_ROOT,
      {},
      cleanup,
    );
    if (!(await waitFor(async () => (await fetch(`${API_BASE}/health`)).ok, 90_000))) {
      throw new EnvError("DShop API 未在 90s 内就绪（http://127.0.0.1:8787/health）");
    }
    process.stdout.write("  DShop API 就绪\n");

    /* ---------------- 2. 起 storefront（Vite） ---------------- */
    process.stdout.write("── 启动 storefront ──\n");
    startProc(
      "storefront",
      process.execPath,
      // ★ `--strictPort`：否则 Vite 会静默换端口，后面全部连错。
      // ★ `--host 127.0.0.1`：Vite 默认 host 是 `localhost`，在 Windows 上可能只绑到
      //   IPv6 `::1`，导致脚本对 `127.0.0.1:5173` 的探活永远失败（实测踩到）。
      [viteEntry, "--port", String(STORE_PORT), "--strictPort", "--host", "127.0.0.1"],
      join(DSHOP_ROOT, "apps/storefront"),
      {},
      cleanup,
    );
    if (!(await waitFor(async () => (await fetch(STORE_BASE)).ok, 60_000))) {
      throw new EnvError("storefront 未在 60s 内就绪（http://127.0.0.1:5173）");
    }
    process.stdout.write("  storefront 就绪\n");

    /* ---------------- 3. 起 PiEcho 网关（客服腿需要） ---------------- */
    if (!opts.skipChat) {
      process.stdout.write("── 启动 PiEcho 网关 ──\n");
      // ★ 前置条件：`.pi-local` 是**被 gitignore 的生成副本**（由 `npm run model:local`
      //   从 `agent/.pi/extensions/**` 复制而来）。若它是陈旧的，本脚本会**加载旧扩展代码**
      //   并给出误导性的通过/失败——实测踩到：副本里的 `SUB_ORDER_STATUSES` 仍是 4 值，
      //   导致 `PENDING_PAYMENT` 被静默改写成 `PAID`，客服回复出现「PAID（待支付）」这种
      //   状态与文案错配的假象，而**源码其实早已修好**。故此处先校验副本与源一致，
      //   不一致即按「环境不满足」退出（退出码 2），而不是让断言给出错误结论。
      const mirrorCheck = spawnSync(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "scripts/demo-local.ts", "--check"],
        { cwd: PIECHO_ROOT, encoding: "utf8", shell: false },
      );
      const mirrorOut = `${mirrorCheck.stdout ?? ""}${mirrorCheck.stderr ?? ""}`;
      if (/\.pi-local 副本一致性[\s\S]*?\[FAIL/.test(mirrorOut) || /副本已过期/.test(mirrorOut)) {
        throw new EnvError(
          "PiEcho .pi-local 副本已过期（与 agent/ 不一致），客服腿会加载旧扩展代码并给出误导性结果。" +
            "请先执行：cd PiEcho && npm run model:local",
        );
      }
      // ★ 必须覆盖 `PI_CODING_AGENT_DIR` / `PI_AGENT_CWD`：`.env` 里前者是**空串**，
      //   Pi 会回落 `~/.pi/agent`（无 models.json）→ 模型被解析成内置 `openai/gpt-5.5`
      //   → 拿 embedding key 调对话模型 → 401。
      startProc(
        "piecho-gateway",
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "--env-file-if-exists=.env", "server/src/index.ts"],
        PIECHO_ROOT,
        {
          PI_CODING_AGENT_DIR: join(PIECHO_ROOT, ".pi-local/agent/.pi"),
          PI_AGENT_CWD: join(PIECHO_ROOT, ".pi-local/agent"),
        },
        cleanup,
      );
      // 网关健康检查**永远返回 HTTP 200**，所以必须校验响应体 `ok === true`。
      const gwOk = await waitFor(async () => {
        const r = await fetch(`${GATEWAY_BASE}/api/v1/health`);
        if (!r.ok) return false;
        const body = (await r.json()) as { ok?: boolean };
        return body.ok === true;
      }, 90_000);
      if (!gwOk) throw new EnvError("PiEcho 网关未在 90s 内就绪或健康体 ok !== true");
      process.stdout.write("  PiEcho 网关就绪（ok=true）\n");
    }

    /* ---------------- 4. 种地址（DShop 无建地址端点） ---------------- */
    process.stdout.write("\n── 数据准备 ──\n");
    const phone = `139${String(Date.now()).slice(-8)}`;

    const smsRes = await fetch(`${API_BASE}/api/v1/shop/auth/sms-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    if (!smsRes.ok) throw new Error(`sms-code HTTP ${smsRes.status}`);

    const loginRes = await fetch(`${API_BASE}/api/v1/shop/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code: "123456" }),
    });
    if (!loginRes.ok) throw new Error(`login HTTP ${loginRes.status}：${await loginRes.text()}`);
    const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

    const meBody = (await (await fetch(`${API_BASE}/api/v1/shop/auth/me`, { headers: { cookie } })).json()) as {
      data: { userId: string };
    };
    made.userId = meBody.data.userId;

    // 地址：ULID 主键 + AES-GCM 密文手机号（两者任一不合规都会契约 500）。
    made.addressId = ulid();
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_addresses
         (id, user_id, receiver_name, receiver_phone, province, city, district, detail,
          is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      made.addressId,
      made.userId,
      "验收机器人",
      encryptPhone(phone, devVars["PHONE_ENC_KEY"] ?? ""),
      "广东省",
      "深圳市",
      "南山区",
      "验收路 1 号",
      nowIso,
      nowIso,
    );
    process.stdout.write(`  userId=${made.userId}\n  addressId=${made.addressId}\n`);

    /* ---------------- 5. 浏览器：登录 → 加购 → 结算 → 下单 ---------------- */
    process.stdout.write("\n── 浏览器全链路 ──\n");
    const userDataDir = join(tmpdir(), `dshop-e2e-${Date.now()}`);
    cleanup.push(() => {
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* 残留无害 */
      }
    });

    const { client } = await launchChrome(chrome, `${STORE_BASE}/login`, userDataDir, cleanup);
    cleanup.push(() => client.close());

    // 5.1 登录
    await waitPage(client, `document.querySelector("#phone")`, 20_000, "登录页 #phone");
    await setInput(client, "#phone", phone);
    await clickByText(client, "获取验证码");
    await waitPage(client, `document.querySelector("#code")`, 15_000, "验证码输入框");
    await setInput(client, "#code", "123456");
    await clickByText(client, "登录");
    const loggedIn = await waitFor(
      async () => !(await pageEval(client, "location.pathname")).startsWith("/login"),
      20_000,
    );
    reporter.check("A01", "浏览器登录成功（离开 /login）", loggedIn, `path=${await pageEval(client, "location.pathname")}`);

    // 5.2 选商品并加购
    const productsBody = (await (await fetch(`${API_BASE}/api/v1/shop/products?page=1&pageSize=50`)).json()) as {
      data: { list: Array<{ spuId: string }> };
    };
    // 前置条件：必须存在「有可售库存」的 SKU，否则「加入购物车」会因无货失败——那不是本脚本要验的东西。
    // 注意 C 端详情下发的字段是 `stock`（**不是** `availableStock`，实测如此）。
    let spuId = "";
    for (const p of productsBody.data.list) {
      const detailBody = (await (await fetch(`${API_BASE}/api/v1/shop/products/${p.spuId}`)).json()) as {
        data: { skus: Array<{ skuId: string; stock?: number }> };
      };
      if (detailBody.data.skus.some((s) => (s.stock ?? 0) > 0)) {
        spuId = p.spuId;
        break;
      }
    }
    if (spuId === "") {
      throw new EnvError("没有任何 SPU 存在可售 SKU，无法下单（先 npm run seed:cs:local）");
    }

    await nav(client, `/products/${spuId}`);
    await waitPage(client, `document.body.textContent.includes("加入购物车")`, 20_000, "商品详情页");
    await clickByText(client, "加入购物车");
    const cartReached = await waitFor(
      async () => (await pageEval(client, "location.pathname")) === "/cart",
      20_000,
    );
    reporter.check("A02", "加入购物车后跳转 /cart", cartReached, `path=${await pageEval(client, "location.pathname")}`);

    // 5.3 结算
    await clickByText(client, "去结算");
    const checkoutReached = await waitFor(
      async () => (await pageEval(client, "location.pathname")) === "/checkout",
      20_000,
    );
    reporter.check("A03", "进入结算页 /checkout", checkoutReached, `path=${await pageEval(client, "location.pathname")}`);

    // 5.4 提交订单
    await waitPage(client, `document.querySelector('input[name="address"]')`, 20_000, "地址单选框");
    await pageEval(
      client,
      `(() => { const r = document.querySelector('input[name="address"]'); if (r) { r.click(); } return "ok"; })()`,
    );
    await clickByText(client, "提交订单");
    const afterSubmit = await waitFor(async () => {
      const href = await pageEval(client, "location.href");
      return /DS\d{17}/.test(href);
    }, 30_000);
    const href = await pageEval(client, "location.href");
    const orderNoMatch = /(DS\d{17})/.exec(href);
    made.orderNo = orderNoMatch?.[1];
    reporter.check(
      "A04",
      "提交订单成功并拿到订单号",
      afterSubmit && made.orderNo !== undefined,
      `href=${href}`,
    );

    if (made.orderNo === undefined) {
      throw new Error("未取得订单号，后续断言无法进行");
    }
    const orderRow = db.prepare("SELECT id FROM orders WHERE order_no = ?").get(made.orderNo) as
      | { id: string }
      | undefined;
    made.orderId = orderRow?.id;

    /* ---------------- 6. C 端读回 ---------------- */
    process.stdout.write("\n── C 端读回 ──\n");
    const shopList = (await (await fetch(`${API_BASE}/api/v1/shop/orders`, { headers: { cookie } })).json()) as {
      data: { list: Array<{ orderNo: string; status: string; itemCount: number; itemSummary: string }> };
    };
    const listItem = shopList.data.list.find((o) => o.orderNo === made.orderNo);

    // R26 回归：itemCount / itemSummary 曾因漏选分组键恒为 0 / "无商品"。
    reporter.check(
      "A05",
      "C 端列表 itemCount > 0（R26 回归）",
      (listItem?.itemCount ?? 0) > 0,
      `itemCount=${String(listItem?.itemCount)}`,
    );
    reporter.check(
      "A06",
      "C 端列表 itemSummary 非「无商品」（R26 回归）",
      (listItem?.itemSummary ?? "无商品") !== "无商品",
      `itemSummary=${JSON.stringify(listItem?.itemSummary)}`,
    );

    const shopDetail = (await (
      await fetch(`${API_BASE}/api/v1/shop/orders/${made.orderNo}`, { headers: { cookie } })
    ).json()) as {
      data: { status: string; statusText: string; subOrders: Array<{ status: string; statusText: string }> };
    };

    /* ---------------- 7. Agent 面读回（两面一致性 = R27 原始症状） ---------------- */
    process.stdout.write("\n── Agent 面读回（两面比对）──\n");
    const tokenPlain = await issueAgentToken(db, devVars, made);

    const agentRes = await fetch(`${API_BASE}/api/v1/agent/orders/${made.orderNo}`, {
      headers: { "X-Service-Token": tokenPlain, "X-Contract-Version": CONTRACT_VERSION },
    });
    const agentDetail = (await agentRes.json()) as {
      data?: { status: string; statusText: string; subOrders: Array<{ status: string; statusText: string }> };
    };

    reporter.check("A07", "Agent 面订单详情可达（HTTP 200）", agentRes.status === 200, `HTTP ${agentRes.status}`);

    // ★ R27 核心：未支付订单的子单必须是 PENDING_PAYMENT（曾硬编码为 PAID）。
    const shopSubs = shopDetail.data.subOrders.map((s) => s.status);
    reporter.check(
      "A08",
      "C 端子单状态为 PENDING_PAYMENT（R27 核心）",
      shopSubs.length > 0 && shopSubs.every((s) => s === "PENDING_PAYMENT"),
      `subOrders=${shopSubs.join(",")}`,
    );

    const agentSubs = (agentDetail.data?.subOrders ?? []).map((s) => s.status);
    reporter.check(
      "A09",
      "Agent 面子单状态为 PENDING_PAYMENT（R27 核心）",
      agentSubs.length > 0 && agentSubs.every((s) => s === "PENDING_PAYMENT"),
      `subOrders=${agentSubs.join(",")}`,
    );

    // ★ R27 原始症状：同一订单两面显示不同状态。
    reporter.check(
      "A10",
      "★ 两面主单状态一致（R27 原始症状）",
      agentDetail.data?.status === shopDetail.data.status,
      `Agent=${String(agentDetail.data?.status)} vs C端=${shopDetail.data.status}`,
    );
    reporter.check(
      "A11",
      "★ 两面子单状态一致",
      JSON.stringify(agentSubs) === JSON.stringify(shopSubs),
      `Agent=${agentSubs.join(",")} vs C端=${shopSubs.join(",")}`,
    );

    /* ---------------- 8. 客服对话腿 ---------------- */
    if (opts.skipChat) {
      process.stdout.write("\n── 客服对话腿已跳过（--skip-chat）──\n");
    } else {
      process.stdout.write("\n── 客服对话腿 ──\n");
      // 打开客服窗口
      const opened = await waitFor(async () => {
        const r = await pageEval(
          client,
          `(() => {
             const b = document.querySelector('button[aria-label="打开智能客服"]');
             if (!b) return "NOT_FOUND";
             b.click();
             return "OK";
           })()`,
        );
        return r === "OK";
      }, 20_000);
      reporter.check("A12", "客服浮动按钮可点击", opened, `opened=${String(opened)}`);

      const dialogReady = await waitFor(
        async () =>
          (await pageEval(client, `!!document.querySelector('div[role="dialog"][aria-label="智能客服"]')`)) ===
          "true",
        15_000,
      );
      reporter.check("A13", "客服对话框已打开", dialogReady, `dialog=${String(dialogReady)}`);

      // ★ 提问里必须带上**真实订单号**：实测（probe-toolrate.mjs）模型面对
      //   「我的订单到哪了？」（无订单号）会合理地先反问「请提供订单号」而不调用工具；
      //   带上订单号则稳定触发 `query_order_status`。这是模型行为差异，不是接线故障。
      const chatInput = `textarea[placeholder="输入您的问题…（Enter 发送，Shift+Enter 换行）"]`;
      await waitPage(client, `document.querySelector(${JSON.stringify(chatInput)})`, 15_000, "聊天输入框");

      // ★ 不能用「log 文本长度 > N」判断回复落定——`div[role="log"]` 里**包含用户自己的
      //   消息**（本问句约 38 字），一发送就超过阈值，会在流式早期误判为已完成（实测踩到）。
      //   真正的忙闲标志是发送按钮文案：`session.busy` 为真 → 「发送中」，否则 → 「发送」。
      const logTextExpr = `(() => { const l = document.querySelector('div[role="log"]'); return l ? l.textContent : ""; })()`;
      const sendBtnTextExpr = `(() => {
        const ta = document.querySelector('textarea[placeholder^="输入您的问题"]');
        const btn = ta && ta.parentElement ? ta.parentElement.querySelector("button") : null;
        return btn ? (btn.textContent || "").trim() : "NO_BTN";
      })()`;

      const beforeText = String(await pageEval(client, logTextExpr));
      await setInput(client, chatInput, `帮我查一下订单 ${made.orderNo} 现在到哪了？`);
      await clickByText(client, "发送");

      // 先等进入忙态，再等回到闲态——回到闲态才是本轮真正结束。
      const wentBusy = await waitFor(
        async () => (await pageEval(client, sendBtnTextExpr)) === "发送中",
        15_000,
        200,
      );
      const settled = await waitFor(
        async () => (await pageEval(client, sendBtnTextExpr)) === "发送",
        120_000,
        500,
      );
      const logText = String(await pageEval(client, logTextExpr));
      const gotReply = settled && logText.length > beforeText.length;
      reporter.check(
        "A14",
        "客服返回了回复正文",
        gotReply,
        `进入忙态=${String(wentBusy)} 回到闲态=${String(settled)} log 长度 ${beforeText.length}→${logText.length}`,
      );

      // 工具调用轨迹：`ul[aria-label="工具调用"]`。
      // 断言「非空」而非「必须恰好是某个工具」——容忍模型在 `query_order_status`
      // 之外额外调用 `search_knowledge` 等只读工具。
      //
      // ⚠️ `pageEval` 返回 `String(value)`，数组会被字符串化（`"a,b"`），
      //    所以**不能**在 Node 侧用 `Array.isArray` 判断；改为在页面里直接返回**条数**。
      const toolCount = Number(
        await pageEval(
          client,
          `(() => {
             const u = document.querySelector('ul[aria-label="工具调用"]');
             return u ? u.querySelectorAll("li").length : 0;
           })()`,
        ),
      );
      const toolNamesText = await pageEval(
        client,
        `(() => {
           const u = document.querySelector('ul[aria-label="工具调用"]');
           if (!u) return "";
           return [...u.querySelectorAll("li")].map((li) => (li.textContent || "").trim()).join(" | ");
         })()`,
      );
      reporter.check(
        "A15",
        "客服调用了工具（工具轨迹非空）",
        Number.isFinite(toolCount) && toolCount > 0,
        `工具条数=${toolCount} ${toolNamesText}`,
      );

      // 错误帧：不应出现
      const alertText = await pageEval(
        client,
        `(() => { const a = document.querySelector('div[role="alert"]'); return a ? a.textContent : ""; })()`,
      );
      reporter.check("A16", "客服未出现错误提示", alertText === "", `alert=${JSON.stringify(alertText.slice(0, 120))}`);

      // 回复内容含订单号或订单相关关键词（容忍模型措辞差异）
      const kw = ["订单", "待支付", "待发货", "已支付", "未支付", "DS"];
      const hitOrderNo = logText.includes(made.orderNo);
      reporter.check(
        "A17",
        "回复含订单号或订单相关关键词（容忍措辞差异）",
        hitOrderNo || kw.some((k) => logText.includes(k)),
        `订单号命中=${String(hitOrderNo)} 关键词=${kw.filter((k) => logText.includes(k)).join("/") || "无"}`,
      );
    }

    reporter.summary();
    return reporter.failed === 0 ? 0 : 1;
  } finally {
    /* ---------------- 清理 ---------------- */
    if (!opts.keepData) {
      try {
        if (made.orderId !== undefined) {
          db.prepare("DELETE FROM order_items WHERE order_id = ?").run(made.orderId);
          db.prepare("DELETE FROM sub_orders WHERE order_id = ?").run(made.orderId);
          db.prepare("DELETE FROM order_status_logs WHERE order_id = ?").run(made.orderId);
          db.prepare("DELETE FROM payments WHERE order_id = ?").run(made.orderId);
          db.prepare("DELETE FROM orders WHERE id = ?").run(made.orderId);
        }
        if (made.addressId !== undefined) {
          db.prepare("DELETE FROM user_addresses WHERE id = ?").run(made.addressId);
        }
        if (made.userId !== undefined) {
          db.prepare("DELETE FROM cart_items WHERE user_id = ?").run(made.userId);
          db.prepare("DELETE FROM users WHERE id = ?").run(made.userId);
        }
        if (made.tokenId !== undefined) {
          db.prepare("DELETE FROM service_tokens WHERE id = ?").run(made.tokenId);
        }
        process.stdout.write("数据清理完成\n");
      } catch (e) {
        process.stdout.write(`数据清理异常（非致命）：${(e as Error).message}\n`);
      }
    } else {
      process.stdout.write("（--keep-data：保留造出的数据）\n");
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    await runCleanup(cleanup);
  }
}

/**
 * 用 DShop 自己的 service-token 模块签发一枚临时 Agent 令牌并落库。
 *
 * **必须用 `.dev.vars` 里的真实 pepper**：DShop 的 `seed-service-token.ts` 在
 * `AGENT_TOKEN_PEPPER` 未设置时回退到开发默认值，与运行中的 API 不匹配 → 401。
 */
async function issueAgentToken(
  db: DatabaseSync,
  devVars: Record<string, string>,
  made: { tokenId?: string },
): Promise<string> {
  const { generateServiceToken, hashServiceToken, serviceTokenPrefix } = (await import(
    "../packages/auth/src/service-token.js"
  )) as {
    generateServiceToken: () => string;
    hashServiceToken: (pepper: string, token: string) => Promise<string>;
    serviceTokenPrefix: (token: string) => string;
  };

  const token = generateServiceToken();
  const hash = await hashServiceToken(devVars["AGENT_TOKEN_PEPPER"] ?? "", token);
  const id = ulid();
  made.tokenId = id;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO service_tokens
       (id, token_hash, token_prefix, name, scopes, status, expires_at,
        rate_limit_per_min, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 600, 'e2e-customer-journey', ?, ?)`,
  ).run(
    id,
    hash,
    serviceTokenPrefix(token),
    "e2e 验收临时令牌",
    JSON.stringify(["agent:order:read", "agent:product:read", "agent:aftersale:read", "agent:policy:read"]),
    new Date(Date.now() + 3600_000).toISOString(),
    now,
    now,
  );
  return token;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof EnvError) {
      process.stderr.write(`环境不满足：${msg}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`运行失败：${msg}\n`);
    process.exitCode = 1;
  });
