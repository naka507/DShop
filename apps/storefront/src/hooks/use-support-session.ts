/**
 * 智能客服会话 Hook（React 原生）。
 *
 * 把 `SupportClient` 的事件流收敛成 React 状态：消息列表、思考面板、工具轨迹、
 * 快捷动作、错误与发送中标记。组件只负责渲染。
 *
 * 与 PiEcho 侧 `web/src/useChatSession.ts`（Vue composable）职责对应，
 * 此处是 DShop 侧的 React 重写（C 端客服窗口归 DShop，`docs/11` §14.3 Q11）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  SupportClient,
  SupportError,
  startNewSession,
  type SupportAction,
  type ToolTrace,
} from "../api/support.ts";

/** 一条会话消息（用户或助手）。 */
export interface SupportMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  /** 正文（助手消息在流式过程中持续追加）。 */
  readonly text: string;
  /** 助手消息：思考过程（折叠展示）。 */
  readonly thinking: string;
  /** 助手消息：工具轨迹。 */
  readonly tools: readonly ToolTrace[];
  /** 助手消息：快捷动作（仅 `finish` 后非空）。 */
  readonly actions: readonly SupportAction[];
  /** 是否仍在流式输出。 */
  readonly streaming: boolean;
  /** 该条的错误提示（若失败）。 */
  readonly error: string | null;
}

/** `useSupportSession` 的返回值。 */
export interface SupportSession {
  readonly messages: readonly SupportMessage[];
  /** 顶部状态条文案（`null` 表示无）。 */
  readonly status: string | null;
  /** 是否正在等待/接收。 */
  readonly busy: boolean;
  /** 发送一条消息；`text` 为空则忽略。 */
  readonly send: (text: string) => Promise<void>;
  /** 重试最后一条用户消息（仅在其失败后可用）。 */
  readonly retry: () => Promise<void>;
  /** 清空当前会话（重新生成 sessionId）。 */
  readonly reset: () => void;
  /** 转人工（返回工单号）。 */
  readonly handover: (summary: string) => Promise<string>;
  /** 会话 ID（调试与展示用）。 */
  readonly sessionId: string;
}

/** 状态阶段 → 中文文案。 */
const STATUS_TEXT: Record<string, string> = {
  thinking: "思考中…",
  compacting: "整理上下文…",
  degraded: "已降级（部分能力不可用）",
};

/** 简易自增 id（仅用于 React key，无需全局唯一）。 */
let seq = 0;
const nextId = (prefix: string): string => {
  seq += 1;
  return `${prefix}-${String(seq)}`;
};

/** 生成错误文案。 */
function describe(error: unknown): string {
  if (error instanceof SupportError) {
    return error.status === 401 ? "登录状态已失效，请重试" : error.message;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return "已取消";
    return error.message;
  }
  return "服务异常，请稍后重试";
}

/**
 * 客服会话状态机。
 *
 * @param client 注入的客户端（测试用；缺省自建）。
 */
export function useSupportSession(client?: SupportClient): SupportSession {
  const clientRef = useRef<SupportClient | null>(null);
  if (clientRef.current === null) clientRef.current = client ?? new SupportClient();
  const active = clientRef.current;

  const [messages, setMessages] = useState<readonly SupportMessage[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState(active.sessionId);

  /** 当前流的中止控制器（卸载或重发时取消）。 */
  const abortRef = useRef<AbortController | null>(null);
  /** 组件是否已卸载：避免卸载后 setState。 */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  /** 就地更新最后一条助手消息。 */
  const patchAssistant = useCallback(
    (assistantId: string, patch: (previous: SupportMessage) => SupportMessage) => {
      if (!mountedRef.current) return;
      setMessages((previous) =>
        previous.map((message) => (message.id === assistantId ? patch(message) : message)),
      );
    },
    [],
  );

  const runTurn = useCallback(
    async (text: string) => {
      const userMessage: SupportMessage = {
        id: nextId("user"),
        role: "user",
        text,
        thinking: "",
        tools: [],
        actions: [],
        streaming: false,
        error: null,
      };
      const assistantId = nextId("assistant");
      const assistantMessage: SupportMessage = {
        id: assistantId,
        role: "assistant",
        text: "",
        thinking: "",
        tools: [],
        actions: [],
        streaming: true,
        error: null,
      };

      setMessages((previous) => [...previous, userMessage, assistantMessage]);
      setBusy(true);
      setStatus(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await active.streamChat(
          text,
          {
            onStatus: (phase) => {
              if (mountedRef.current) setStatus(STATUS_TEXT[phase] ?? phase);
            },
            onThinking: (delta) => {
              patchAssistant(assistantId, (previous) => ({
                ...previous,
                thinking: previous.thinking + delta,
              }));
            },
            onDelta: (delta) => {
              patchAssistant(assistantId, (previous) => ({ ...previous, text: previous.text + delta }));
            },
            onToolCall: (trace) => {
              patchAssistant(assistantId, (previous) => ({
                ...previous,
                tools: [...previous.tools, trace],
              }));
            },
            onToolResult: (trace) => {
              // 按 `callId` 合并回对应的调用条目（网关先发 call 再发 result）。
              patchAssistant(assistantId, (previous) => ({
                ...previous,
                tools: previous.tools.map((item) =>
                  item.callId === trace.callId
                    ? { ...item, ok: trace.ok, ms: trace.ms }
                    : item,
                ),
              }));
            },
            onFinish: (actions) => {
              patchAssistant(assistantId, (previous) => ({ ...previous, actions }));
            },
            onError: (error) => {
              patchAssistant(assistantId, (previous) => ({ ...previous, error: error.message }));
            },
            onSessionRotated: (rotated) => {
              if (mountedRef.current) setSessionId(rotated);
            },
          },
          { signal: controller.signal },
        );
      } catch (cause) {
        const message = describe(cause);
        // 用户主动取消不算错误。
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          patchAssistant(assistantId, (previous) => ({ ...previous, error: message }));
        }
      } finally {
        patchAssistant(assistantId, (previous) => ({ ...previous, streaming: false }));
        if (mountedRef.current) {
          setBusy(false);
          setStatus(null);
        }
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [active, patchAssistant],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "" || busy) return;
      await runTurn(trimmed);
    },
    [busy, runTurn],
  );

  const retry = useCallback(async () => {
    if (busy) return;
    // 找到最后一条用户消息（失败后重发它）。
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (lastUser === undefined) return;
    await runTurn(lastUser.text);
  }, [busy, messages, runTurn]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setStatus(null);
    setBusy(false);
    // 必须生成**新**会话 ID 并持久化：直接 `new SupportClient()` 会 `loadSessionId()`
    // 读回同一个已持久化的 ID，「清空」实际仍挂在旧会话上。
    const freshId = startNewSession();
    clientRef.current = new SupportClient({ sessionId: freshId });
    setSessionId(freshId);
  }, []);

  const handover = useCallback(
    async (summary: string): Promise<string> => {
      const result = await active.requestHandover({
        reason: "用户请求人工客服",
        priority: "normal",
        summary,
      });
      return result.ticketNo;
    },
    [active],
  );

  return useMemo(
    () => ({ messages, status, busy, send, retry, reset, handover, sessionId }),
    [messages, status, busy, send, retry, reset, handover, sessionId],
  );
}
