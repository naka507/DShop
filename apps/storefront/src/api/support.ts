/**
 * PiEcho 智能客服网关客户端（DShop storefront 侧）。
 *
 * ## 与 `api/transport.ts` 的关系：**刻意不复用**
 *
 * `transport.ts` 的铁律二是「统一响应体 `{code,message,data}`」，但 **PiEcho 网关
 * 不遵循该信封**——它直接返回裸对象（`{token,expiresAt}`）与 `text/event-stream`。
 * 硬套 `request()` 会把成功响应当成「响应体不符合统一响应体」而抛错。
 * 铁律一（只走相对路径）**照旧适用**，故此处同样拒绝绝对 URL。
 *
 * ## 归属
 *
 * C 端客服窗口归 DShop（`docs/11` §14.1 与 §15 Q11）；PiEcho 只提供服务。
 * 本文件是 PiEcho `web/src/api.ts`（Vue）的 React 侧对应实现。
 *
 * ## 三项集成契约的现状（`docs/11` §15 Q11）
 *
 * ① CORS：PiEcho 网关**无 CORS 配置**，因此**必须**经同源反代访问（见
 *    `vite.config.ts` 的 `supportProxy`，生产走 Service Binding），不可直连。
 * ② 鉴权：`POST /api/v1/auth/session` 是**免签**入口，用于换取短时 JWT。
 * ③ 用户身份：网关侧 `sessions.user_id` 与 DShop `users.id` **尚无映射约定**，
 *    故此处**不传** `context.userId`（传了也无从对应）。待 Q11 契约落地后再补。
 */

import { SseFrameParser, type SseFrame } from "../support/sse.ts";

/** 网关基址：同源相对路径（铁律一）。 */
const SUPPORT_PREFIX = "/api/v1";

/** 会话 ID 在 `localStorage` 的键。 */
const SESSION_STORAGE_KEY = "piecho.support.sessionId";

/** 令牌过期前的提前刷新余量（毫秒）：避免边界上刚好过期。 */
const TOKEN_REFRESH_SKEW_MS = 30_000;

/** 可替换的 fetch 实现（测试注入用）。 */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetcher: Fetcher = (input, init) => fetch(input, init);

/** 网关调用失败。 */
export class SupportError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "SupportError";
    this.code = code;
    this.status = status;
  }
}

/** `POST /api/v1/auth/session` 响应。 */
export interface SupportToken {
  readonly token: string;
  /** ISO-8601 过期时刻（网关侧 `exp ≤ 30min`）。 */
  readonly expiresAt: string;
}

/**
 * 强制开启一个新会话：生成新 ID 并持久化，返回它。
 *
 * ⚠️ 不能靠「新建 `SupportClient`」来换会话——构造时会 `loadSessionId()`
 * 读回**同一个**已持久化的 ID，于是「清空会话」实际仍挂在旧会话上。
 */
export function startNewSession(): string {
  const created = newSessionId();
  saveSessionId(created);
  return created;
}

/** `finish` 事件的快捷动作（与 `packages/shared/src/sse.ts` 的 `Action` 判别联合对应）。 */
export type SupportAction =
  | { readonly type: "handover" }
  | { readonly type: "view_order"; readonly orderNo?: string }
  | { readonly type: "rephrase" }
  | { readonly type: "product_card"; readonly spuId: string };

/** 工具轨迹条目。 */
export interface ToolTrace {
  readonly callId: string;
  readonly name: string;
  readonly label: string;
  readonly inputSummary: string;
  readonly ok?: boolean;
  readonly ms?: number;
}

/** 一次对话流的事件回调集合。 */
export interface StreamHandlers {
  /** 顶部状态条（`thinking` / `compacting` / `degraded`）。 */
  readonly onStatus?: (phase: string) => void;
  /** 思考增量（折叠面板）。 */
  readonly onThinking?: (delta: string) => void;
  /** 正文增量（打字机）。 */
  readonly onDelta?: (delta: string) => void;
  /** 工具调用开始。 */
  readonly onToolCall?: (trace: ToolTrace) => void;
  /** 工具调用结束。 */
  readonly onToolResult?: (trace: ToolTrace) => void;
  /** 流结束，带快捷动作。 */
  readonly onFinish?: (actions: readonly SupportAction[]) => void;
  /** 网关错误事件。 */
  readonly onError?: (error: { code: number; message: string; retryable: boolean }) => void;
  /** 会话因 TTL 超时被轮换（`X-Session-Id`）。 */
  readonly onSessionRotated?: (sessionId: string) => void;
}

/** 一次 `streamChat` 的结果汇总。 */
export interface StreamResult {
  /** 本次收到的最后一个事件 id（用作下次 `Last-Event-ID`）。 */
  readonly lastEventId: string | null;
  /** 是否正常收到 `finish`。 */
  readonly finished: boolean;
}

/**
 * 生成会话 ID。
 *
 * 网关只要求 `z.string().min(1)`，但 `sessions.id` 是 ULID 主键
 * （`06 §8` 第 11 行），故这里生成**符合 ULID 形状**的 26 位 Crockford base32，
 * 与网关侧 `newUlid()` 的产物同构，避免落库时形态不一致。
 */
export function newSessionId(nowMs: number = Date.now()): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  let t = nowMs;
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let random = "";
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 16; i += 1) random += ALPHABET[(bytes[i] ?? 0) % 32] ?? "0";
  return time + random;
}

/** 读取持久化的会话 ID（无则新建并持久化）。 */
export function loadSessionId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(SESSION_STORAGE_KEY);
    if (typeof existing === "string" && existing.length > 0) return existing;
  } catch {
    // 隐私模式下 localStorage 可能抛错：降级为内存态。
  }
  const created = newSessionId();
  saveSessionId(created);
  return created;
}

/** 持久化会话 ID（轮换后必须调用，否则会每轮重复触发轮换）。 */
export function saveSessionId(sessionId: string): void {
  try {
    globalThis.localStorage?.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // 同上，忽略。
  }
}

/** 构造同源 URL；绝对 URL 直接抛错（铁律一）。 */
function buildUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new SupportError(
      `同源转发铁律：客服网关调用禁止使用绝对 URL（收到 ${path}），见 docs/11 §15 Q11`,
      "ERR_SUPPORT_ABSOLUTE_URL",
      0,
    );
  }
  return path.startsWith("/") ? path : `/${path}`;
}

/** 解析网关错误响应体（裸 `{code,message}`，无统一信封）。 */
async function readError(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    return {
      code: typeof body.code === "number" || typeof body.code === "string" ? String(body.code) : "",
      message: typeof body.message === "string" ? body.message : `HTTP ${String(response.status)}`,
    };
  } catch {
    return { code: "", message: `HTTP ${String(response.status)}` };
  }
}

/** 带 JSON 体的网关请求。 */
async function postJson<T>(
  path: string,
  body: unknown,
  fetcher: Fetcher,
  headers: Record<string, string> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(buildUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      credentials: "include",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SupportError(`网络请求失败：${message}`, "", 0);
  }
  if (!response.ok) {
    const { code, message } = await readError(response);
    throw new SupportError(message, code, response.status);
  }
  return (await response.json()) as T;
}

/** 带令牌的 GET 请求。 */
async function getJson<T>(path: string, token: string, fetcher: Fetcher): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(buildUrl(path), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      credentials: "include",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SupportError(`网络请求失败：${message}`, "", 0);
  }
  if (!response.ok) {
    const { code, message } = await readError(response);
    throw new SupportError(message, code, response.status);
  }
  return (await response.json()) as T;
}

/** 令牌是否仍可用（留 `TOKEN_REFRESH_SKEW_MS` 余量）。 */
export function isTokenFresh(token: SupportToken, nowMs: number = Date.now()): boolean {
  const expiry = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiry)) return false;
  return expiry - TOKEN_REFRESH_SKEW_MS > nowMs;
}

/**
 * 客服会话客户端。
 *
 * 生命周期：`ensureToken()` → `streamChat()`（可多次）→ `getSessionDetail()` 等。
 * 令牌过期时 `streamChat` 会**自动重取一次**再重试，避免用户看到「突然掉线」。
 */
export class SupportClient {
  #sessionId: string;
  #token: SupportToken | null = null;
  readonly #fetcher: Fetcher;

  constructor(options: { sessionId?: string; fetcher?: Fetcher } = {}) {
    this.#sessionId = options.sessionId ?? loadSessionId();
    this.#fetcher = options.fetcher ?? defaultFetcher;
  }

  /** 当前会话 ID（可能因 TTL 轮换而变化）。 */
  get sessionId(): string {
    return this.#sessionId;
  }

  /** 换取短时令牌（`POST /api/v1/auth/session`，免签入口）。 */
  async ensureToken(): Promise<SupportToken> {
    if (this.#token !== null && isTokenFresh(this.#token)) return this.#token;
    const token = await postJson<SupportToken>(
      `${SUPPORT_PREFIX}/auth/session`,
      { sessionId: this.#sessionId },
      this.#fetcher,
    );
    this.#token = token;
    return token;
  }

  /**
   * 发起一轮对话并消费 SSE 流。
   *
   * @param text 用户输入。
   * @param handlers 事件回调。
   * @param options.signal 取消信号（组件卸载时务必传入）。
   * @param options.lastEventId 断线重连时的增量补发游标。
   */
  async streamChat(
    text: string,
    handlers: StreamHandlers = {},
    options: { signal?: AbortSignal; lastEventId?: string | null; context?: { spuId?: string } } = {},
  ): Promise<StreamResult> {
    let token = await this.ensureToken();
    let attempt = 0;
    for (;;) {
      try {
        return await this.#streamOnce(text, token.token, handlers, options);
      } catch (cause) {
        // 令牌过期（401）：自动重取一次再试。`attempt` 上限防止无限循环。
        const expired =
          cause instanceof SupportError && cause.status === 401 && attempt === 0;
        if (!expired) throw cause;
        attempt += 1;
        this.#token = null;
        token = await this.ensureToken();
      }
    }
  }

  /** 单次建流与消费。 */
  async #streamOnce(
    text: string,
    token: string,
    handlers: StreamHandlers,
    options: { signal?: AbortSignal; lastEventId?: string | null; context?: { spuId?: string } },
  ): Promise<StreamResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
    };
    // 断线重连：带上游标，网关只补发该 id 之后的事件（`server/src/routes/sessions.ts`）。
    if (typeof options.lastEventId === "string" && options.lastEventId !== "") {
      headers["last-event-id"] = options.lastEventId;
    }

    let response: Response;
    try {
      response = await this.#fetcher(buildUrl(`${SUPPORT_PREFIX}/chat`), {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: this.#sessionId,
          text,
          ...(options.context === undefined ? {} : { context: options.context }),
        }),
        credentials: "include",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SupportError(`网络请求失败：${message}`, "", 0);
    }

    // 会话 TTL 超时被轮换：网关用响应头回传新 ID，必须改用它。
    const rotated = response.headers.get("X-Session-Id");
    if (typeof rotated === "string" && rotated !== "" && rotated !== this.#sessionId) {
      this.#sessionId = rotated;
      saveSessionId(rotated);
      handlers.onSessionRotated?.(rotated);
    }

    if (!response.ok) {
      const { code, message } = await readError(response);
      throw new SupportError(message, code, response.status);
    }
    if (response.body === null) {
      throw new SupportError("响应没有可读流", "ERR_SUPPORT_NO_BODY", response.status);
    }

    return this.#consume(response.body, handlers);
  }

  /** 消费 SSE 字节流并派发事件。 */
  async #consume(body: ReadableStream<Uint8Array>, handlers: StreamHandlers): Promise<StreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    let lastEventId: string | null = null;
    let finished = false;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.id !== null) lastEventId = frame.id;
          if (dispatch(frame, handlers)) {
            finished = true;
            return { lastEventId, finished };
          }
        }
      }
      for (const frame of parser.flush()) {
        if (frame.id !== null) lastEventId = frame.id;
        if (dispatch(frame, handlers)) {
          finished = true;
          break;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // 流已结束或已被取消。
      }
    }
    return { lastEventId, finished };
  }

  /** `GET /api/v1/sessions/:id` —— 会话详情与历史消息。 */
  async getSessionDetail(): Promise<unknown> {
    const token = await this.ensureToken();
    return getJson(`${SUPPORT_PREFIX}/sessions/${this.#sessionId}`, token.token, this.#fetcher);
  }

  /** `POST /api/v1/handover` —— 转人工，返回工单号。 */
  async requestHandover(input: {
    reason: string;
    priority: "normal" | "urgent";
    summary: string;
  }): Promise<{ ticketNo: string }> {
    const token = await this.ensureToken();
    return postJson<{ ticketNo: string }>(
      `${SUPPORT_PREFIX}/handover`,
      { sessionId: this.#sessionId, ...input },
      this.#fetcher,
      { authorization: `Bearer ${token.token}` },
    );
  }

  /** `GET /api/v1/tickets/:ticketNo` —— 工单查询。 */
  async getTicket(ticketNo: string): Promise<unknown> {
    const token = await this.ensureToken();
    return getJson(`${SUPPORT_PREFIX}/tickets/${encodeURIComponent(ticketNo)}`, token.token, this.#fetcher);
  }
}

/**
 * 把一帧派发给回调。
 *
 * @returns 是否应停止消费（`finish` / `error`）。
 */
function dispatch(frame: SseFrame, handlers: StreamHandlers): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data) as unknown;
  } catch {
    // 非 JSON 载荷（网关不发，但防御性忽略，避免整条流因一帧崩掉）。
    return false;
  }
  const data = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;

  switch (frame.event) {
    case "status":
      if (typeof data.phase === "string") handlers.onStatus?.(data.phase);
      return false;
    case "thinking":
      if (typeof data.delta === "string") handlers.onThinking?.(data.delta);
      return false;
    case "chunk":
      // ⚠️ 正文增量字段名是 `delta`（不是 `text`）。
      if (typeof data.delta === "string") handlers.onDelta?.(data.delta);
      return false;
    case "tool_call":
      handlers.onToolCall?.({
        callId: String(data.callId ?? ""),
        name: String(data.name ?? ""),
        label: String(data.label ?? ""),
        inputSummary: String(data.inputSummary ?? ""),
      });
      return false;
    case "tool_result":
      handlers.onToolResult?.({
        callId: String(data.callId ?? ""),
        name: String(data.name ?? ""),
        label: "",
        inputSummary: "",
        ok: data.ok === true,
        ms: typeof data.ms === "number" ? data.ms : undefined,
      });
      return false;
    case "finish":
      handlers.onFinish?.(normalizeActions(data.suggestedActions));
      return true;
    case "error":
      handlers.onError?.({
        code: typeof data.code === "number" ? data.code : 0,
        message: typeof data.message === "string" ? data.message : "服务异常",
        retryable: data.retryable === true,
      });
      return true;
    default:
      // 未知事件名：忽略，保持前向兼容。
      return false;
  }
}

/** 校验并收敛 `suggestedActions`（服务端异常形态不至于让前端崩掉）。 */
export function normalizeActions(raw: unknown): readonly SupportAction[] {
  if (!Array.isArray(raw)) return [];
  const actions: SupportAction[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    switch (record.type) {
      case "handover":
        actions.push({ type: "handover" });
        break;
      case "view_order":
        actions.push({
          type: "view_order",
          ...(typeof record.orderNo === "string" ? { orderNo: record.orderNo } : {}),
        });
        break;
      case "rephrase":
        actions.push({ type: "rephrase" });
        break;
      case "product_card":
        if (typeof record.spuId === "string") {
          actions.push({ type: "product_card", spuId: record.spuId });
        }
        break;
      default:
        break;
    }
  }
  return actions;
}
