/**
 * 客服会话 Hook 与窗口组件测试。
 *
 * 组件测试**注入假 `SupportClient`**（`SupportPanel`/`SupportWidget` 的 `client` 属性），
 * 不打网络、不依赖 PiEcho 网关。
 *
 * 重点覆盖三处「错了不会报错、只会显示不对」的行为：
 * 1. `tool_result` 必须按 `callId` **合并**回已有轨迹，而不是新增一条；
 * 2. 流结束时 `streaming` 必须落回 `false`（否则光标一直闪）；
 * 3. `reset` 必须换到**新** sessionId（否则「新会话」实际挂在旧会话上）。
 */

import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import {
  SupportClient,
  SupportError,
  type Fetcher,
  type StreamHandlers,
} from "../src/api/support.ts";
import { SupportPanel, SupportWidget } from "../src/components/support-widget.tsx";
import { useSupportSession } from "../src/hooks/use-support-session.ts";

/* -------------------------------------------------------------------------- */
/* 测试替身                                                                    */
/* -------------------------------------------------------------------------- */

/** 记录 `streamChat` 收到的事件序列，供断言使用。 */
interface FakeClient {
  readonly client: SupportClient;
  /** 依次排队的「一轮」事件（每轮对应一次 `streamChat`）。 */
  readonly script: ((handlers: StreamHandlers) => void | Promise<void>)[];
  readonly sent: string[];
}

/**
 * 构造一个假客户端。
 *
 * 直接构造真实的 `SupportClient` 会打网络，故此处用最小对象冒充 ——
 * Hook 只依赖 `sessionId` 与 `streamChat`/`requestHandover`。
 */
function fakeClient(script: ((handlers: StreamHandlers) => void | Promise<void>)[] = []): FakeClient {
  const sent: string[] = [];
  const state = {
    sessionId: "01J9Z8K2M4N5P6Q7R8S9T0TEST",
  };

  const client = {
    get sessionId(): string {
      return state.sessionId;
    },
    async streamChat(text: string, handlers: StreamHandlers = {}): Promise<{ lastEventId: string | null; finished: boolean }> {
      sent.push(text);
      const next = script.shift();
      if (next !== undefined) await next(handlers);
      return { lastEventId: null, finished: true };
    },
    async requestHandover(): Promise<{ ticketNo: string }> {
      return { ticketNo: "T20260929001" };
    },
  } as unknown as SupportClient;

  return { client, script, sent };
}

/** 包一层 Router（组件用 `Link` 渲染快捷动作）。 */
function withRouter(node: ReactNode): ReactNode {
  return <MemoryRouter>{node}</MemoryRouter>;
}

beforeEach(() => {
  localStorage.clear();
});

/* -------------------------------------------------------------------------- */
/* Hook                                                                        */
/* -------------------------------------------------------------------------- */

describe("useSupportSession", () => {
  it("初始为空消息、非忙、状态为空", () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useSupportSession(client));

    expect(result.current.messages).toEqual([]);
    expect(result.current.busy).toBe(false);
    expect(result.current.status).toBeNull();
    expect(result.current.sessionId).toBe("01J9Z8K2M4N5P6Q7R8S9T0TEST");
  });

  it("send 追加用户消息与助手消息，并累积正文增量", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onDelta?.("您的");
        handlers.onDelta?.("订单已发货");
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("我的订单到哪了");
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({ role: "user", text: "我的订单到哪了" });
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", text: "您的订单已发货" });
    expect(result.current.busy).toBe(false);
  });

  it("流进行中 streaming 为 true，流结束后落回 false", async () => {
    // 用一道「闸门」把流卡在中途，才能在流进行中观察状态；
    // 直接 await send() 再读 result.current 只能看到终态。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = fakeClient([
      async (handlers) => {
        handlers.onDelta?.("x");
        await gate;
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.send("hi");
    });

    expect(result.current.messages[1]?.streaming).toBe(true);
    expect(result.current.busy).toBe(true);

    await act(async () => {
      release();
      await pending;
    });

    expect(result.current.messages[1]?.streaming).toBe(false);
    expect(result.current.busy).toBe(false);
  });

  it("status 阶段在流进行中可见，流结束后复位", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = fakeClient([
      async (handlers) => {
        handlers.onStatus?.("thinking");
        await gate;
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.send("hi");
    });

    expect(result.current.status).toBe("思考中…");

    await act(async () => {
      release();
      await pending;
    });

    expect(result.current.status).toBeNull();
  });

  it("未知阶段名原样展示（不静默丢状态）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = fakeClient([
      async (handlers) => {
        handlers.onStatus?.("warming_up");
        await gate;
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.send("hi");
    });

    expect(result.current.status).toBe("warming_up");

    await act(async () => {
      release();
      await pending;
    });
  });

  it("thinking 增量累积到助手消息", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onThinking?.("先查订单");
        handlers.onThinking?.("，再看物流");
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.messages[1]?.thinking).toBe("先查订单，再看物流");
  });

  it("tool_result 按 callId 合并回已有轨迹，而不是新增一条", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onToolCall?.({
          callId: "c1",
          name: "query_order_status",
          label: "查询订单",
          inputSummary: "DS20260920143000123",
        });
        handlers.onToolResult?.({
          callId: "c1",
          name: "query_order_status",
          label: "",
          inputSummary: "",
          ok: true,
          ms: 42,
        });
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("hi");
    });

    const tools = result.current.messages[1]?.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      callId: "c1",
      label: "查询订单",
      inputSummary: "DS20260920143000123",
      ok: true,
      ms: 42,
    });
  });

  it("callId 对不上的 tool_result 不会误改其它轨迹", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onToolCall?.({
          callId: "c1",
          name: "query_order_status",
          label: "查询订单",
          inputSummary: "",
        });
        handlers.onToolResult?.({
          callId: "other",
          name: "search_knowledge",
          label: "",
          inputSummary: "",
          ok: false,
          ms: 9,
        });
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("hi");
    });

    const tools = result.current.messages[1]?.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.ok).toBeUndefined();
    expect(tools[0]?.label).toBe("查询订单");
  });

  it("finish 的快捷动作写入助手消息", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onFinish?.([{ type: "view_order", orderNo: "DS1" }, { type: "handover" }]);
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.messages[1]?.actions).toEqual([
      { type: "view_order", orderNo: "DS1" },
      { type: "handover" },
    ]);
  });

  it("onError 事件把错误写到助手消息（不抛出）", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onError?.({ code: 5001, message: "模型超时", retryable: true });
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.messages[1]?.error).toBe("模型超时");
    expect(result.current.busy).toBe(false);
  });

  it("会话轮换时更新 sessionId", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onSessionRotated?.("01J9Z8K2M4N5P6Q7R8S9T0NEW0");
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.sessionId).toBe("01J9Z8K2M4N5P6Q7R8S9T0NEW0");
  });

  it("send 忽略空白文本，不产生消息", async () => {
    const { client, sent } = fakeClient();
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("   ");
    });

    expect(sent).toEqual([]);
    expect(result.current.messages).toEqual([]);
  });

  it("send 会 trim 首尾空白", async () => {
    const { client, sent } = fakeClient();
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("  你好  ");
    });

    expect(sent).toEqual(["你好"]);
    expect(result.current.messages[0]?.text).toBe("你好");
  });

  it("streamChat 抛错时把错误写到助手消息", async () => {
    const { client } = fakeClient([
      () => {
        throw new SupportError("商城不可用", "ERR_ESHOP_UNAVAILABLE", 503);
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.messages[1]?.error).toBe("商城不可用");
    expect(result.current.messages[1]?.streaming).toBe(false);
  });

  it("401 错误翻成「登录状态已失效，请重试」", async () => {
    const { client } = fakeClient([
      () => {
        throw new SupportError("令牌已过期", "ERR_UNAUTHORIZED", 401);
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.messages[1]?.error).toBe("登录状态已失效，请重试");
  });

  it("AbortError 不写成错误（用户主动取消）", async () => {
    const { client } = fakeClient([
      () => {
        throw new DOMException("aborted", "AbortError");
      },
    ]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("hi");
    });

    expect(result.current.messages[1]?.error).toBeNull();
  });

  it("retry 重发最后一条用户消息", async () => {
    const { client, sent } = fakeClient([() => undefined, () => undefined]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("订单到哪了");
    });
    await act(async () => {
      await result.current.retry();
    });

    expect(sent).toEqual(["订单到哪了", "订单到哪了"]);
    // 重试会新增一对消息（不做原地覆盖）。
    expect(result.current.messages).toHaveLength(4);
  });

  it("没有用户消息时 retry 不做任何事", async () => {
    const { client, sent } = fakeClient();
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.retry();
    });

    expect(sent).toEqual([]);
  });

  it("reset 清空消息并换到新 sessionId", async () => {
    const { client } = fakeClient([(handlers) => handlers.onDelta?.("hi")]);
    const { result } = renderHook(() => useSupportSession(client));

    await act(async () => {
      await result.current.send("你好");
    });
    const before = result.current.sessionId;

    act(() => {
      result.current.reset();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.status).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.sessionId).not.toBe(before);
    expect(result.current.sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("handover 返回工单号", async () => {
    const { client } = fakeClient();
    const { result } = renderHook(() => useSupportSession(client));

    let ticketNo = "";
    await act(async () => {
      ticketNo = await result.current.handover("订单问题");
    });

    expect(ticketNo).toBe("T20260929001");
  });
});

/* -------------------------------------------------------------------------- */
/* 组件                                                                        */
/* -------------------------------------------------------------------------- */

describe("SupportPanel", () => {
  it("空态展示欢迎语与引导问题", () => {
    const { client } = fakeClient();
    render(withRouter(<SupportPanel client={client} />));

    expect(screen.getByText("您好，我是智能客服，请问有什么可以帮您？")).toBeTruthy();
    expect(screen.getByText("我的订单到哪了？")).toBeTruthy();
    expect(screen.getByText("这个商品有货吗？")).toBeTruthy();
    expect(screen.getByText("怎么申请退货？")).toBeTruthy();
  });

  it("输入框为空时发送按钮禁用", () => {
    const { client } = fakeClient();
    render(withRouter(<SupportPanel client={client} />));

    const button = screen.getByRole("button", { name: "发送" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("输入文字后点击发送：渲染用户气泡与助手正文", async () => {
    const { client, sent } = fakeClient([(handlers) => handlers.onDelta?.("已为您查询")]);
    render(withRouter(<SupportPanel client={client} />));

    fireEvent.change(screen.getByPlaceholderText(/输入您的问题/), { target: { value: "订单到哪了" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getByText("已为您查询")).toBeTruthy();
    });
    expect(sent).toEqual(["订单到哪了"]);
    expect(screen.getByText("订单到哪了")).toBeTruthy();
  });

  it("Enter 发送，Shift+Enter 不发送", async () => {
    const { client, sent } = fakeClient([() => undefined, () => undefined]);
    render(withRouter(<SupportPanel client={client} />));

    const input = screen.getByPlaceholderText(/输入您的问题/);
    fireEvent.change(input, { target: { value: "第一句" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(sent).toEqual([]);

    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await waitFor(() => {
      expect(sent).toEqual(["第一句"]);
    });
  });

  it("点击引导问题直接发送", async () => {
    const { client, sent } = fakeClient([() => undefined]);
    render(withRouter(<SupportPanel client={client} />));

    fireEvent.click(screen.getByText("怎么申请退货？"));

    await waitFor(() => {
      expect(sent).toEqual(["怎么申请退货？"]);
    });
  });

  it("思考过程折叠展示", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onThinking?.("先查订单状态");
        handlers.onDelta?.("已发货");
      },
    ]);
    render(withRouter(<SupportPanel client={client} />));

    fireEvent.change(screen.getByPlaceholderText(/输入您的问题/), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getByText("思考过程")).toBeTruthy();
    });
    expect(screen.getByText("先查订单状态")).toBeTruthy();
  });

  it("工具轨迹渲染 label 与耗时", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onToolCall?.({
          callId: "c1",
          name: "query_order_status",
          label: "查询订单",
          inputSummary: "DS20260920143000123",
        });
        handlers.onToolResult?.({
          callId: "c1",
          name: "query_order_status",
          label: "",
          inputSummary: "",
          ok: true,
          ms: 42,
        });
      },
    ]);
    render(withRouter(<SupportPanel client={client} />));

    fireEvent.change(screen.getByPlaceholderText(/输入您的问题/), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getByLabelText("工具调用")).toBeTruthy();
    });
    const list = screen.getByLabelText("工具调用");
    expect(within(list).getByText("查询订单")).toBeTruthy();
    expect(within(list).getByText("DS20260920143000123")).toBeTruthy();
    expect(within(list).getByText("42ms")).toBeTruthy();
  });

  it("finish 的快捷动作渲染为按钮/链接", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onFinish?.([
          { type: "handover" },
          { type: "view_order", orderNo: "DS20260920143000123" },
          { type: "product_card", spuId: "01J9Z8K2M4N5P6Q7R8S9T0V1W2" },
          { type: "rephrase" },
        ]);
      },
    ]);
    render(withRouter(<SupportPanel client={client} />));

    fireEvent.change(screen.getByPlaceholderText(/输入您的问题/), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "转人工客服" })).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: "查看订单" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看商品" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "换个说法" })).toBeTruthy();
  });

  it("转人工成功后展示工单号", async () => {
    const { client } = fakeClient([
      (handlers) => {
        handlers.onFinish?.([{ type: "handover" }]);
      },
    ]);
    render(withRouter(<SupportPanel client={client} />));

    fireEvent.change(screen.getByPlaceholderText(/输入您的问题/), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "转人工客服" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "转人工客服" }));

    await waitFor(() => {
      expect(screen.getByText("T20260929001")).toBeTruthy();
    });
  });

  it("错误展示为 alert 并带重试按钮", async () => {
    const { client } = fakeClient([(handlers) => handlers.onError?.({ code: 1, message: "模型超时", retryable: true })]);
    render(withRouter(<SupportPanel client={client} />));

    fireEvent.change(screen.getByPlaceholderText(/输入您的问题/), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(within(screen.getByRole("alert")).getByText("模型超时")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("「新会话」清空消息", async () => {
    const { client } = fakeClient([(handlers) => handlers.onDelta?.("答复")]);
    render(withRouter(<SupportPanel client={client} />));

    fireEvent.change(screen.getByPlaceholderText(/输入您的问题/), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect(screen.getByText("答复")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "新会话" }));

    await waitFor(() => {
      expect(screen.getByText("您好，我是智能客服，请问有什么可以帮您？")).toBeTruthy();
    });
    expect(screen.queryByText("答复")).toBeNull();
  });

  it("传入 onClose 时渲染关闭按钮并回调", () => {
    const { client } = fakeClient();
    let closed = 0;
    render(withRouter(<SupportPanel client={client} onClose={() => (closed += 1)} />));

    fireEvent.click(screen.getByRole("button", { name: "关闭客服窗口" }));

    expect(closed).toBe(1);
  });

  it("未传 onClose 时不渲染关闭按钮", () => {
    const { client } = fakeClient();
    render(withRouter(<SupportPanel client={client} />));

    expect(screen.queryByRole("button", { name: "关闭客服窗口" })).toBeNull();
  });
});

describe("SupportWidget", () => {
  it("初始只渲染浮动按钮，不渲染对话框", () => {
    const { client } = fakeClient();
    render(withRouter(<SupportWidget client={client} />));

    expect(screen.getByRole("button", { name: "打开智能客服" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("点击浮动按钮打开抽屉，按钮消失", () => {
    const { client } = fakeClient();
    render(withRouter(<SupportWidget client={client} />));

    fireEvent.click(screen.getByRole("button", { name: "打开智能客服" }));

    expect(screen.getByRole("dialog", { name: "智能客服" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开智能客服" })).toBeNull();
    expect(screen.getByText("您好，我是智能客服，请问有什么可以帮您？")).toBeTruthy();
  });

  it("抽屉内关闭后回到浮动按钮", () => {
    const { client } = fakeClient();
    render(withRouter(<SupportWidget client={client} />));

    fireEvent.click(screen.getByRole("button", { name: "打开智能客服" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭客服窗口" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "打开智能客服" })).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* 真实客户端的注入路径                                                        */
/* -------------------------------------------------------------------------- */

describe("注入真实 SupportClient 时不打网络", () => {
  it("未 send 时一次请求都不发", () => {
    const calls: string[] = [];
    const fetcher: Fetcher = (url) => {
      calls.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const client = new SupportClient({ sessionId: "s", fetcher });

    render(withRouter(<SupportPanel client={client} />));

    expect(calls).toEqual([]);
  });
});
