/**
 * 客服网关客户端单测（`src/api/support.ts`）。
 *
 * 全部用例都**注入假 `fetch`**（`SupportClient` 的 `fetcher` 选项），
 * 不打真实网络、不依赖 PiEcho 网关进程。
 *
 * 重点覆盖三类「静默出错」的行为：
 * 1. 正文增量字段名是 `delta`（写成 `text` 会静默不显示）；
 * 2. 401 时自动重取令牌且**只重试一次**（否则会无限循环）；
 * 3. `X-Session-Id` 轮换必须回写 `localStorage`（否则每轮重复轮换）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SupportClient,
  SupportError,
  isTokenFresh,
  newSessionId,
  normalizeActions,
  startNewSession,
  type Fetcher,
} from "../src/api/support.ts";

/** 会话 ID 的存储键（与 `src/api/support.ts` 保持一致）。 */
const SESSION_KEY = "piecho.support.sessionId";

/** 把字符串包成 SSE 响应体。 */
function sseResponse(
  frames: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/event-stream", ...init.headers },
  });
}

/** 分多次投递的 SSE 响应体（用于验证跨 chunk 半帧）。 */
function chunkedSseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** 构造 `{token,expiresAt}` 令牌响应。 */
function tokenResponse(token: string, minutes = 30): Response {
  return new Response(
    JSON.stringify({ token, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 记录调用并按队列返回响应。 */
function scriptedFetcher(
  handler: (url: string, init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>,
): { fetcher: Fetcher; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: Fetcher = (url, init) => {
    const index = calls.length;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init, index));
  };
  return { fetcher, calls };
}

/** 取请求头（大小写不敏感）。 */
function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const hit = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return hit?.[1];
  }
  const record = headers as Record<string, string>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}

beforeEach(() => {
  localStorage.clear();
});

describe("newSessionId", () => {
  it("生成 26 位 Crockford base32（ULID 形状）", () => {
    expect(newSessionId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("前 10 位编码时间戳（同一时刻前缀相同）", () => {
    const now = 1_700_000_000_000;
    const a = newSessionId(now);
    const b = newSessionId(now);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    // 后 16 位随机，两次不同（碰撞概率 32^-16，可忽略）。
    expect(a).not.toBe(b);
  });

  it("时间戳为 0 时前缀全 0", () => {
    expect(newSessionId(0).slice(0, 10)).toBe("0000000000");
  });
});

describe("isTokenFresh", () => {
  it("过期前（留足余量）视为新鲜", () => {
    const token = { token: "t", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    expect(isTokenFresh(token)).toBe(true);
  });

  it("进入 30 秒余量即视为过期", () => {
    const token = { token: "t", expiresAt: new Date(Date.now() + 10_000).toISOString() };
    expect(isTokenFresh(token)).toBe(false);
  });

  it("已过期视为不新鲜", () => {
    const token = { token: "t", expiresAt: new Date(Date.now() - 1_000).toISOString() };
    expect(isTokenFresh(token)).toBe(false);
  });

  it("无法解析的 expiresAt 视为不新鲜", () => {
    expect(isTokenFresh({ token: "t", expiresAt: "not-a-date" })).toBe(false);
  });
});

describe("normalizeActions", () => {
  it("保留四种合法动作", () => {
    const actions = normalizeActions([
      { type: "handover" },
      { type: "view_order", orderNo: "DS20260929192452001" },
      { type: "rephrase" },
      { type: "product_card", spuId: "01J9Z8K2M4N5P6Q7R8S9T0V1W2" },
    ]);
    expect(actions).toEqual([
      { type: "handover" },
      { type: "view_order", orderNo: "DS20260929192452001" },
      { type: "rephrase" },
      { type: "product_card", spuId: "01J9Z8K2M4N5P6Q7R8S9T0V1W2" },
    ]);
  });

  it("非数组返回空数组", () => {
    expect(normalizeActions(undefined)).toEqual([]);
    expect(normalizeActions("handover")).toEqual([]);
    expect(normalizeActions(null)).toEqual([]);
  });

  it("丢弃未知类型与非对象元素", () => {
    expect(normalizeActions([{ type: "unknown" }, null, 42, "x", { type: "handover" }])).toEqual([
      { type: "handover" },
    ]);
  });

  it("product_card 缺 spuId 时丢弃", () => {
    expect(normalizeActions([{ type: "product_card" }])).toEqual([]);
  });

  it("view_order 缺 orderNo 时保留（跳转到订单列表）", () => {
    expect(normalizeActions([{ type: "view_order" }])).toEqual([{ type: "view_order" }]);
  });
});

describe("SupportClient.ensureToken", () => {
  it("调用免签入口 `POST /api/v1/auth/session` 并带 sessionId", async () => {
    const { fetcher, calls } = scriptedFetcher(() => tokenResponse("tk-1"));
    const client = new SupportClient({ sessionId: "01J9Z8K2M4N5P6Q7R8S9T0AAAA", fetcher });

    const token = await client.ensureToken();

    expect(token.token).toBe("tk-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/auth/session");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sessionId: "01J9Z8K2M4N5P6Q7R8S9T0AAAA",
    });
  });

  it("令牌仍新鲜时复用缓存，不重复请求", async () => {
    const { fetcher, calls } = scriptedFetcher(() => tokenResponse("tk-1"));
    const client = new SupportClient({ sessionId: "s", fetcher });

    await client.ensureToken();
    await client.ensureToken();

    expect(calls).toHaveLength(1);
  });

  it("令牌进入刷新余量后重新请求", async () => {
    let n = 0;
    const { fetcher, calls } = scriptedFetcher(() => {
      n += 1;
      return n === 1
        ? tokenResponse("tk-1", 0.2) // 12 秒后过期 → 落在 30 秒余量内
        : tokenResponse("tk-2");
    });
    const client = new SupportClient({ sessionId: "s", fetcher });

    await client.ensureToken();
    const second = await client.ensureToken();

    expect(second.token).toBe("tk-2");
    expect(calls).toHaveLength(2);
  });

  it("网关返回错误时抛 SupportError（带 code 与 status）", async () => {
    const { fetcher } = scriptedFetcher(
      () =>
        new Response(JSON.stringify({ code: "ERR_SESSION_JWT_SECRET_MISSING", message: "未配置密钥" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    await expect(client.ensureToken()).rejects.toBeInstanceOf(SupportError);
    await expect(client.ensureToken()).rejects.toMatchObject({
      code: "ERR_SESSION_JWT_SECRET_MISSING",
      status: 500,
    });
  });

  it("网络异常包装成 SupportError", async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error("connection refused"));
    const client = new SupportClient({ sessionId: "s", fetcher });

    await expect(client.ensureToken()).rejects.toThrow(/网络请求失败/);
  });
});

describe("SupportClient.streamChat", () => {
  it("派发 status / thinking / chunk / finish，并返回 lastEventId", async () => {
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : sseResponse(
            [
              'id: 1\nevent: status\ndata: {"phase":"thinking"}\n\n',
              'id: 2\nevent: thinking\ndata: {"delta":"先看订单"}\n\n',
              'id: 3\nevent: chunk\ndata: {"delta":"您的"}\n\n',
              'id: 4\nevent: chunk\ndata: {"delta":"订单已发货"}\n\n',
              'id: 5\nevent: finish\ndata: {"messageId":"m1","suggestedActions":[{"type":"view_order","orderNo":"DS1"}]}\n\n',
            ].join(""),
          ),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    const statuses: string[] = [];
    let thinking = "";
    let text = "";
    const actions: unknown[] = [];
    const result = await client.streamChat("我的订单到哪了", {
      onStatus: (phase) => statuses.push(phase),
      onThinking: (delta) => {
        thinking += delta;
      },
      onDelta: (delta) => {
        text += delta;
      },
      onFinish: (list) => actions.push(...list),
    });

    expect(statuses).toEqual(["thinking"]);
    expect(thinking).toBe("先看订单");
    expect(text).toBe("您的订单已发货");
    expect(actions).toEqual([{ type: "view_order", orderNo: "DS1" }]);
    expect(result).toEqual({ lastEventId: "5", finished: true });
  });

  it("正文增量只认 `delta` 字段（`text` 被忽略）", async () => {
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : sseResponse('event: chunk\ndata: {"text":"不该显示"}\n\nevent: finish\ndata: {}\n\n'),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    let text = "";
    await client.streamChat("hi", {
      onDelta: (delta) => {
        text += delta;
      },
    });

    expect(text).toBe("");
  });

  it("tool_call 与 tool_result 按 callId 成对送达", async () => {
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : sseResponse(
            [
              'event: tool_call\ndata: {"callId":"c1","name":"query_order_status","label":"查询订单","inputSummary":"DS20260920143000123"}\n\n',
              'event: tool_result\ndata: {"callId":"c1","name":"query_order_status","ok":true,"ms":42}\n\n',
              'event: finish\ndata: {}\n\n',
            ].join(""),
          ),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    const calls: unknown[] = [];
    const results: unknown[] = [];
    await client.streamChat("hi", {
      onToolCall: (trace) => calls.push(trace),
      onToolResult: (trace) => results.push(trace),
    });

    expect(calls).toEqual([
      {
        callId: "c1",
        name: "query_order_status",
        label: "查询订单",
        inputSummary: "DS20260920143000123",
      },
    ]);
    expect(results).toEqual([
      { callId: "c1", name: "query_order_status", label: "", inputSummary: "", ok: true, ms: 42 },
    ]);
  });

  it("`error` 事件停止消费并回传 retryable", async () => {
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : sseResponse(
            [
              'event: chunk\ndata: {"delta":"部分"}\n\n',
              'event: error\ndata: {"code":5001,"message":"模型超时","retryable":true}\n\n',
              'event: chunk\ndata: {"delta":"不该出现"}\n\n',
            ].join(""),
          ),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    let text = "";
    const errors: unknown[] = [];
    const result = await client.streamChat("hi", {
      onDelta: (delta) => {
        text += delta;
      },
      onError: (error) => errors.push(error),
    });

    expect(text).toBe("部分");
    expect(errors).toEqual([{ code: 5001, message: "模型超时", retryable: true }]);
    expect(result.finished).toBe(true);
  });

  it("跨 chunk 的半帧不会丢消息", async () => {
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : chunkedSseResponse([
            'event: chu',
            'nk\ndata: {"delta":"半',
            '帧"}\n\nevent: finish\ndata: {}\n\n',
          ]),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    let text = "";
    await client.streamChat("hi", {
      onDelta: (delta) => {
        text += delta;
      },
    });

    expect(text).toBe("半帧");
  });

  it("心跳注释帧被忽略，不影响正文", async () => {
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : sseResponse(
            'event: chunk\ndata: {"delta":"a"}\n\n: ping\n\nevent: chunk\ndata: {"delta":"b"}\n\nevent: finish\ndata: {}\n\n',
          ),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    let text = "";
    await client.streamChat("hi", {
      onDelta: (delta) => {
        text += delta;
      },
    });

    expect(text).toBe("ab");
  });

  it("未收到 finish 时 finished 为 false（流提前结束）", async () => {
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : sseResponse('event: chunk\ndata: {"delta":"半句"}\n\n'),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    const result = await client.streamChat("hi");

    expect(result.finished).toBe(false);
    expect(result.lastEventId).toBeNull();
  });

  it("传入 lastEventId 时带上 `last-event-id` 请求头（断线补发）", async () => {
    const { fetcher, calls } = scriptedFetcher((url) =>
      url.endsWith("/auth/session") ? tokenResponse("tk-1") : sseResponse("event: finish\ndata: {}\n\n"),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    await client.streamChat("hi", {}, { lastEventId: "17" });

    const chatCall = calls.find((call) => call.url.endsWith("/chat"));
    expect(header(chatCall?.init, "last-event-id")).toBe("17");
  });

  it("未传 lastEventId 时不带该请求头", async () => {
    const { fetcher, calls } = scriptedFetcher((url) =>
      url.endsWith("/auth/session") ? tokenResponse("tk-1") : sseResponse("event: finish\ndata: {}\n\n"),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    await client.streamChat("hi");

    const chatCall = calls.find((call) => call.url.endsWith("/chat"));
    expect(header(chatCall?.init, "last-event-id")).toBeUndefined();
  });

  it("请求体带 sessionId 与 text；未指定 context 时不带该字段", async () => {
    const { fetcher, calls } = scriptedFetcher((url) =>
      url.endsWith("/auth/session") ? tokenResponse("tk-1") : sseResponse("event: finish\ndata: {}\n\n"),
    );
    const client = new SupportClient({ sessionId: "01J9Z8K2M4N5P6Q7R8S9T0BBBB", fetcher });

    await client.streamChat("你好");

    const chatCall = calls.find((call) => call.url.endsWith("/chat"));
    const body = JSON.parse(String(chatCall?.init?.body)) as Record<string, unknown>;
    expect(body.sessionId).toBe("01J9Z8K2M4N5P6Q7R8S9T0BBBB");
    expect(body.text).toBe("你好");
    expect("context" in body).toBe(false);
  });

  it("传入 context.spuId 时写进请求体", async () => {
    const { fetcher, calls } = scriptedFetcher((url) =>
      url.endsWith("/auth/session") ? tokenResponse("tk-1") : sseResponse("event: finish\ndata: {}\n\n"),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    await client.streamChat("有货吗", {}, { context: { spuId: "01J9Z8K2M4N5P6Q7R8S9T0V1W2" } });

    const chatCall = calls.find((call) => call.url.endsWith("/chat"));
    const body = JSON.parse(String(chatCall?.init?.body)) as Record<string, unknown>;
    expect(body.context).toEqual({ spuId: "01J9Z8K2M4N5P6Q7R8S9T0V1W2" });
  });

  it("401 时自动重取令牌并只重试一次", async () => {
    let authCount = 0;
    const { fetcher, calls } = scriptedFetcher((url) => {
      if (url.endsWith("/auth/session")) {
        authCount += 1;
        return tokenResponse(authCount === 1 ? "tk-old" : "tk-new");
      }
      // 第一次对话用旧令牌 → 401；第二次用新令牌 → 成功。
      return header(calls[calls.length - 1]?.init, "authorization") === "Bearer tk-old"
        ? new Response(JSON.stringify({ code: "ERR_UNAUTHORIZED", message: "令牌已过期" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        : sseResponse("event: finish\ndata: {}\n\n");
    });
    const client = new SupportClient({ sessionId: "s", fetcher });

    const result = await client.streamChat("hi");

    expect(result.finished).toBe(true);
    expect(authCount).toBe(2);
    const chatCalls = calls.filter((call) => call.url.endsWith("/chat"));
    expect(chatCalls).toHaveLength(2);
    expect(header(chatCalls[0]?.init, "authorization")).toBe("Bearer tk-old");
    expect(header(chatCalls[1]?.init, "authorization")).toBe("Bearer tk-new");
  });

  it("连续两次 401 不再重试，抛 SupportError", async () => {
    let chatCount = 0;
    const { fetcher } = scriptedFetcher((url) => {
      if (url.endsWith("/auth/session")) return tokenResponse("tk");
      chatCount += 1;
      return new Response(JSON.stringify({ code: "ERR_UNAUTHORIZED", message: "令牌已过期" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new SupportClient({ sessionId: "s", fetcher });

    await expect(client.streamChat("hi")).rejects.toMatchObject({ status: 401 });
    expect(chatCount).toBe(2);
  });

  it("非 401 错误不重试", async () => {
    let chatCount = 0;
    const { fetcher } = scriptedFetcher((url) => {
      if (url.endsWith("/auth/session")) return tokenResponse("tk");
      chatCount += 1;
      return new Response(JSON.stringify({ code: "ERR_ESHOP_UNAVAILABLE", message: "商城不可用" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new SupportClient({ sessionId: "s", fetcher });

    await expect(client.streamChat("hi")).rejects.toMatchObject({ status: 503 });
    expect(chatCount).toBe(1);
  });

  it("会话被轮换：更新 sessionId、回写 localStorage 并回调", async () => {
    const rotated = "01J9Z8K2M4N5P6Q7R8S9T0CCCC";
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : sseResponse("event: finish\ndata: {}\n\n", { headers: { "X-Session-Id": rotated } }),
    );
    const client = new SupportClient({ sessionId: "01J9Z8K2M4N5P6Q7R8S9T0AAAA", fetcher });

    const seen: string[] = [];
    await client.streamChat("hi", {
      onSessionRotated: (id) => seen.push(id),
    });

    expect(client.sessionId).toBe(rotated);
    expect(localStorage.getItem(SESSION_KEY)).toBe(rotated);
    expect(seen).toEqual([rotated]);
  });

  it("轮换头与当前 sessionId 相同时不回调", async () => {
    const same = "01J9Z8K2M4N5P6Q7R8S9T0AAAA";
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : sseResponse("event: finish\ndata: {}\n\n", { headers: { "X-Session-Id": same } }),
    );
    const client = new SupportClient({ sessionId: same, fetcher });

    const seen: string[] = [];
    await client.streamChat("hi", {
      onSessionRotated: (id) => seen.push(id),
    });

    expect(seen).toEqual([]);
  });

  it("响应无可读流时抛 ERR_SUPPORT_NO_BODY", async () => {
    const { fetcher } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    await expect(client.streamChat("hi")).rejects.toMatchObject({ code: "ERR_SUPPORT_NO_BODY" });
  });

  it("AbortError 原样抛出（不算网络失败）", async () => {
    const controller = new AbortController();
    const { fetcher } = scriptedFetcher((url) => {
      if (url.endsWith("/auth/session")) return tokenResponse("tk-1");
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    const client = new SupportClient({ sessionId: "s", fetcher });

    await expect(
      client.streamChat("hi", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("SupportClient 其他端点", () => {
  it("getSessionDetail 走 `GET /api/v1/sessions/:id` 并带 Bearer", async () => {
    const { fetcher, calls } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : new Response(JSON.stringify({ id: "s", messages: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
    const client = new SupportClient({ sessionId: "01J9Z8K2M4N5P6Q7R8S9T0DDDD", fetcher });

    await client.getSessionDetail();

    const call = calls.find((item) => item.url.includes("/sessions/"));
    expect(call?.url).toBe("/api/v1/sessions/01J9Z8K2M4N5P6Q7R8S9T0DDDD");
    expect(call?.init?.method).toBe("GET");
    expect(header(call?.init, "authorization")).toBe("Bearer tk-1");
  });

  it("requestHandover 提交 sessionId 与理由，返回工单号", async () => {
    const { fetcher, calls } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : new Response(JSON.stringify({ ticketNo: "T20260929001", status: "open", slaMinutes: 30 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
    const client = new SupportClient({ sessionId: "sess-1", fetcher });

    const result = await client.requestHandover({
      reason: "用户请求人工客服",
      priority: "normal",
      summary: "订单问题",
    });

    expect(result.ticketNo).toBe("T20260929001");
    const call = calls.find((item) => item.url.endsWith("/handover"));
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      sessionId: "sess-1",
      reason: "用户请求人工客服",
      priority: "normal",
      summary: "订单问题",
    });
    expect(header(call?.init, "authorization")).toBe("Bearer tk-1");
  });

  it("getTicket 对工单号做 URL 编码", async () => {
    const { fetcher, calls } = scriptedFetcher((url) =>
      url.endsWith("/auth/session")
        ? tokenResponse("tk-1")
        : new Response(JSON.stringify({ ticketNo: "T1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
    const client = new SupportClient({ sessionId: "s", fetcher });

    await client.getTicket("T/2026 001");

    const call = calls.find((item) => item.url.includes("/tickets/"));
    expect(call?.url).toBe("/api/v1/tickets/T%2F2026%20001");
  });

  it("所有请求都走同源相对路径（铁律一）", async () => {
    const { fetcher, calls } = scriptedFetcher((url) => {
      if (url.endsWith("/auth/session")) return tokenResponse("tk-1");
      // `/chat` 是 SSE；其余端点是 JSON。
      return url.endsWith("/chat")
        ? sseResponse("event: finish\ndata: {}\n\n")
        : new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    });
    const client = new SupportClient({ sessionId: "s", fetcher });

    await client.streamChat("hi");
    await client.getSessionDetail();
    await client.getTicket("T1");

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith("/api/v1/")).toBe(true);
    }
  });
});

describe("startNewSession", () => {
  it("生成并持久化一个不同的会话 ID", () => {
    const first = startNewSession();
    const second = startNewSession();

    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second).not.toBe(first);
    expect(localStorage.getItem(SESSION_KEY)).toBe(second);
  });

  it("localStorage 已有值时覆盖它", () => {
    localStorage.setItem(SESSION_KEY, "01J9Z8K2M4N5P6Q7R8S9T0OLD0");
    const fresh = startNewSession();

    expect(fresh).not.toBe("01J9Z8K2M4N5P6Q7R8S9T0OLD0");
    expect(localStorage.getItem(SESSION_KEY)).toBe(fresh);
  });
});

describe("SupportClient 会话 ID 持久化", () => {
  it("未显式传入 sessionId 时读取 localStorage", () => {
    localStorage.setItem(SESSION_KEY, "01J9Z8K2M4N5P6Q7R8S9T0KEEP");
    const client = new SupportClient();

    expect(client.sessionId).toBe("01J9Z8K2M4N5P6Q7R8S9T0KEEP");
  });

  it("localStorage 为空时新建并持久化", () => {
    const client = new SupportClient();

    expect(client.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(localStorage.getItem(SESSION_KEY)).toBe(client.sessionId);
  });

  it("显式传入的 sessionId 优先于 localStorage", () => {
    localStorage.setItem(SESSION_KEY, "01J9Z8K2M4N5P6Q7R8S9T0OLD0");
    const client = new SupportClient({ sessionId: "01J9Z8K2M4N5P6Q7R8S9T0NEW0" });

    expect(client.sessionId).toBe("01J9Z8K2M4N5P6Q7R8S9T0NEW0");
  });
});

describe("绝对 URL 防护（铁律一）", () => {
  it("buildUrl 拒绝绝对 URL —— 由注入的 fetcher 永远收不到绝对地址来体现", async () => {
    const spy: Fetcher = vi.fn(() => Promise.resolve(tokenResponse("tk-1")));
    const client = new SupportClient({ sessionId: "s", fetcher: spy });

    await client.ensureToken();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spy).mock.calls[0]?.[0]).toBe("/api/v1/auth/session");
  });
});
