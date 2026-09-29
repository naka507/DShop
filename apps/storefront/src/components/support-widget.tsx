/**
 * C 端智能客服窗口（React 原生）。
 *
 * ## 归属与背景
 *
 * C 端客服窗口归 DShop（`docs/11` §14.1 与 §15 Q11）；PiEcho 只提供服务。
 * 本组件是 PiEcho `web/` 侧 Vue 调试界面（已降级为本地调试工具）的
 * **React 原生重写**，不是把那份 Vue 代码搬过来。
 *
 * ## 两种挂载形态
 *
 * - `SupportWidget`：右下角浮动按钮 + 抽屉，挂在 `AppShell` 上，全站可用；
 * - `SupportPanel`：会话主体，`/support` 页面内嵌同一份实现。
 *
 * 两者共用 `useSupportSession`（`src/hooks/use-support-session.ts`）；
 * 组件只负责渲染，不持有业务状态。
 *
 * ## 当前边界（如实说明，勿当成已实现）
 *
 * - **不传 `context.userId`**：网关 `sessions.user_id` 与 DShop `users.id`
 *   尚无映射约定（`docs/11` §15 Q11），传了也无从对应；
 * - 客服网关经**同源反代**访问（dev 走 Vite `supportProxy`，生产走
 *   Service Binding）；PiEcho 网关**无 CORS 配置**，不可直连。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import type { SupportClient, SupportAction } from "../api/support.ts";
import {
  useSupportSession,
  type SupportMessage,
  type SupportSession,
} from "../hooks/use-support-session.ts";

/* -------------------------------------------------------------------------- */
/* 小部件                                                                      */
/* -------------------------------------------------------------------------- */

/** 对话图标（内联 SVG，避免为一个图标引入依赖）。 */
function ChatIcon({ className }: { readonly className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

/** 关闭图标。 */
function CloseIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** 流式输出中的光标。 */
function Cursor(): ReactNode {
  return <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-gray-500 align-text-bottom" />;
}

/* -------------------------------------------------------------------------- */
/* 工具轨迹                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 工具轨迹列表。
 *
 * 网关先发 `tool_call`（含 `label`/`inputSummary`）再发 `tool_result`
 * （含 `ok`/`ms`）；Hook 已按 `callId` 合并成一条，这里只渲染。
 */
function ToolTraces({ tools }: { readonly tools: SupportMessage["tools"] }): ReactNode {
  if (tools.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1" aria-label="工具调用">
      {tools.map((tool) => (
        <li
          key={tool.callId === "" ? `${tool.name}-${tool.label}` : tool.callId}
          className="flex items-center gap-1.5 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600"
        >
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              tool.ok === undefined ? "bg-amber-400" : tool.ok ? "bg-green-500" : "bg-red-500"
            }`}
            aria-hidden="true"
          />
          <span className="font-medium">{tool.label === "" ? tool.name : tool.label}</span>
          {tool.inputSummary !== "" && (
            <span className="truncate text-gray-400">{tool.inputSummary}</span>
          )}
          {tool.ms !== undefined && <span className="ml-auto shrink-0 text-gray-400">{tool.ms}ms</span>}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* 快捷动作                                                                    */
/* -------------------------------------------------------------------------- */

const ACTION_BUTTON_CLASS =
  "rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 transition hover:bg-gray-50";

/**
 * `finish.suggestedActions` 渲染。
 *
 * 动作类型与网关 `Action` 判别联合一一对应（`packages/shared/src/sse.ts`）：
 * `handover` / `view_order` / `rephrase` / `product_card`。
 */
function QuickActions({
  actions,
  onHandover,
  onRephrase,
  disabled,
}: {
  readonly actions: readonly SupportAction[];
  readonly onHandover: () => void;
  readonly onRephrase: () => void;
  readonly disabled: boolean;
}): ReactNode {
  if (actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {actions.map((action, index) => {
        const key = `${action.type}-${String(index)}`;
        if (action.type === "handover") {
          return (
            <button
              key={key}
              type="button"
              className={ACTION_BUTTON_CLASS}
              disabled={disabled}
              onClick={onHandover}
            >
              转人工客服
            </button>
          );
        }
        if (action.type === "view_order") {
          const to = action.orderNo === undefined ? "/orders" : `/orders/${encodeURIComponent(action.orderNo)}`;
          return (
            <Link key={key} to={to} className={ACTION_BUTTON_CLASS}>
              查看订单
            </Link>
          );
        }
        if (action.type === "product_card") {
          return (
            <Link
              key={key}
              to={`/products/${encodeURIComponent(action.spuId)}`}
              className={ACTION_BUTTON_CLASS}
            >
              查看商品
            </Link>
          );
        }
        return (
          <button key={key} type="button" className={ACTION_BUTTON_CLASS} onClick={onRephrase}>
            换个说法
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 单条消息                                                                    */
/* -------------------------------------------------------------------------- */

function MessageBubble({
  message,
  onHandover,
  onRephrase,
  onRetry,
  disabled,
}: {
  readonly message: SupportMessage;
  readonly onHandover: () => void;
  readonly onRephrase: () => void;
  readonly onRetry: () => void;
  readonly disabled: boolean;
}): ReactNode {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-gray-900 px-3 py-2 text-sm text-white">
          {message.text}
        </p>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-900">
        {message.thinking !== "" && (
          <details className="mb-2">
            <summary className="cursor-pointer text-xs text-gray-500">思考过程</summary>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-gray-500">
              {message.thinking}
            </p>
          </details>
        )}

        {message.text !== "" && (
          <p className="whitespace-pre-wrap break-words">
            {message.text}
            {message.streaming && <Cursor />}
          </p>
        )}

        {message.text === "" && message.streaming && (
          <p className="text-gray-400" role="status">
            正在生成
            <Cursor />
          </p>
        )}

        <ToolTraces tools={message.tools} />

        <QuickActions
          actions={message.actions}
          onHandover={onHandover}
          onRephrase={onRephrase}
          disabled={disabled}
        />

        {message.error !== null && (
          <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700" role="alert">
            <p>{message.error}</p>
            <button
              type="button"
              className="mt-1 rounded border border-red-300 bg-white px-2 py-0.5 text-red-700"
              disabled={disabled}
              onClick={onRetry}
            >
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 会话主体                                                                    */
/* -------------------------------------------------------------------------- */

/** 空态引导语（点击即发送）。 */
const SUGGESTIONS: readonly string[] = [
  "我的订单到哪了？",
  "这个商品有货吗？",
  "怎么申请退货？",
];

/**
 * 会话主体：消息列表 + 状态条 + 输入框。
 *
 * @param client 注入的客户端（测试用；缺省由 Hook 自建）。
 * @param onClose 传入时显示「关闭」按钮（抽屉形态）。
 * @param className 外层附加类名。
 */
export function SupportPanel({
  client,
  onClose,
  className = "",
}: {
  readonly client?: SupportClient;
  readonly onClose?: () => void;
  readonly className?: string;
}): ReactNode {
  const session: SupportSession = useSupportSession(client);
  const [draft, setDraft] = useState("");
  const [ticketNo, setTicketNo] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 新消息或增量到达时滚到底部。jsdom 无 scrollTo，故做存在性判断。
  useEffect(() => {
    const node = listRef.current;
    if (node === null) return;
    if (typeof node.scrollTo === "function") node.scrollTo({ top: node.scrollHeight });
  }, [session.messages]);

  const lastUserText = (): string => {
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const message = session.messages[i];
      if (message !== undefined && message.role === "user") return message.text;
    }
    return "";
  };

  const submit = (): void => {
    const text = draft.trim();
    if (text === "" || session.busy) return;
    setDraft("");
    void session.send(text);
  };

  const onHandover = (): void => {
    setActionError(null);
    void session
      .handover(lastUserText())
      .then((no) => {
        setTicketNo(no);
      })
      .catch((cause: unknown) => {
        setActionError(cause instanceof Error ? cause.message : "转人工失败，请稍后重试");
      });
  };

  const onRephrase = (): void => {
    inputRef.current?.focus();
  };

  const onReset = (): void => {
    setTicketNo(null);
    setActionError(null);
    setDraft("");
    session.reset();
  };

  return (
    <div className={`flex min-h-0 flex-col bg-white ${className}`}>
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
        <span className="text-sm font-semibold text-gray-900">智能客服</span>
        <span className="truncate text-xs text-gray-400" title={session.sessionId}>
          会话 {session.sessionId.slice(-6)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
            onClick={onReset}
          >
            新会话
          </button>
          {onClose !== undefined && (
            <button
              type="button"
              className="rounded p-1 text-gray-500 hover:bg-gray-100"
              onClick={onClose}
              aria-label="关闭客服窗口"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </div>

      {/* 状态条（thinking / compacting / degraded） */}
      {session.status !== null && (
        <div
          className="flex items-center gap-2 border-b border-blue-100 bg-blue-50 px-3 py-1 text-xs text-blue-700"
          role="status"
        >
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
          {session.status}
        </div>
      )}

      {/* 工单提示 */}
      {ticketNo !== null && (
        <div className="border-b border-green-100 bg-green-50 px-3 py-1 text-xs text-green-700" role="status">
          已转人工，工单号 <span className="font-mono">{ticketNo}</span>
        </div>
      )}
      {actionError !== null && (
        <div className="border-b border-red-100 bg-red-50 px-3 py-1 text-xs text-red-700" role="alert">
          {actionError}
        </div>
      )}

      {/* 消息列表 */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" role="log" aria-live="polite">
        {session.messages.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-gray-500">您好，我是智能客服，请问有什么可以帮您？</p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  type="button"
                  className="rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-600 transition hover:bg-gray-50"
                  onClick={() => {
                    void session.send(text);
                  }}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          session.messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onHandover={onHandover}
              onRephrase={onRephrase}
              onRetry={() => {
                void session.retry();
              }}
              disabled={session.busy}
            />
          ))
        )}
      </div>

      {/* 输入区 */}
      <div className="border-t border-gray-200 p-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="输入您的问题…（Enter 发送，Shift+Enter 换行）"
            className="max-h-24 min-h-[2.25rem] flex-1 resize-none rounded border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-gray-500"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            className="rounded bg-gray-900 px-3 py-2 text-sm text-white transition disabled:opacity-40"
            disabled={session.busy || draft.trim() === ""}
            onClick={submit}
          >
            {session.busy ? "发送中" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 浮动窗口                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 全站浮动客服窗口（右下角按钮 + 抽屉）。
 *
 * 挂在 `AppShell` 上；`/support` 整页形态下由调用方自行隐藏，
 * 避免同屏出现两份会话主体。
 */
export function SupportWidget({ client }: { readonly client?: SupportClient }): ReactNode {
  const [open, setOpen] = useState(false);

  return (
    <>
      {!open && (
        <button
          type="button"
          className="fixed bottom-4 right-4 z-20 flex h-12 w-12 items-center justify-center rounded-full bg-gray-900 text-white shadow-lg transition hover:bg-gray-700"
          aria-label="打开智能客服"
          onClick={() => {
            setOpen(true);
          }}
        >
          <ChatIcon className="h-6 w-6" />
        </button>
      )}

      {open && (
        <div
          className="fixed inset-x-3 bottom-3 z-20 flex h-[min(32rem,calc(100vh-1.5rem))] flex-col overflow-hidden rounded-xl border border-gray-200 shadow-2xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96"
          role="dialog"
          aria-label="智能客服"
        >
          <SupportPanel
            client={client}
            className="h-full"
            onClose={() => {
              setOpen(false);
            }}
          />
        </div>
      )}
    </>
  );
}
