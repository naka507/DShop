/**
 * 登录 / 注册（`docs/03` §3.5.1「会员 / 登录 `/login`」）。
 *
 * - 手机号 + 短信验证码（微信 OAuth 属预留项，`docs/03` §3.5.1 备注）；
 * - 成功后后端 `Set-Cookie`（**HttpOnly**，`aud=shop`，`docs/09` §9.1），
 *   前端**不接触任何 token**，只依赖浏览器自动携带；
 * - 首次登录即注册（「登录/注册」合一），与「手机号 + 短信验证码」的产品口径一致。
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { loginWithSmsCode, sendSmsCode } from "../api/client.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { ErrorNotice } from "../components/ui.tsx";

/** 手机号校验（与 `docs/07` §7.3 的 `phone` 规则一致：11 位、以 1 开头）。 */
const PHONE_PATTERN = /^1\d{10}$/;

/** 登录页。 */
export function LoginPage(): ReactNode {
  const navigate = useNavigate();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const phoneValid = PHONE_PATTERN.test(phone);

  const handleSendCode = async (): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      await sendSmsCode(phone);
      setSent(true);
    } catch (cause) {
      setError(cause);
    } finally {
      setSending(false);
    }
  };

  const handleLogin = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await loginWithSmsCode(phone, code);
      navigate("/account");
    } catch (cause) {
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mx-auto max-w-sm">
      <PageTitle>登录 / 注册</PageTitle>
      <p className="mb-4 text-sm text-gray-500">
        未注册的手机号将自动创建账号。登录态存于 HttpOnly Cookie（`aud=shop`），前端不持有令牌。
      </p>

      <label htmlFor="phone" className="block text-sm text-gray-700">
        手机号
      </label>
      <input
        id="phone"
        type="tel"
        inputMode="numeric"
        value={phone}
        onChange={(event) => {
          setPhone(event.target.value.trim());
        }}
        placeholder="13800000000"
        className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
      />

      <label htmlFor="code" className="mt-3 block text-sm text-gray-700">
        短信验证码
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="code"
          type="text"
          inputMode="numeric"
          value={code}
          onChange={(event) => {
            setCode(event.target.value.trim());
          }}
          className="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          type="button"
          disabled={!phoneValid || sending}
          onClick={() => {
            void handleSendCode();
          }}
          className="rounded border border-gray-300 px-3 py-2 text-sm disabled:opacity-40"
        >
          {sending ? "发送中…" : sent ? "重新发送" : "获取验证码"}
        </button>
      </div>

      {error !== null && (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      )}

      <button
        type="button"
        disabled={!phoneValid || code === "" || submitting}
        onClick={() => {
          void handleLogin();
        }}
        className="mt-4 w-full rounded bg-red-600 py-2 text-sm text-white disabled:opacity-40"
      >
        {submitting ? "登录中…" : "登录 / 注册"}
      </button>
    </section>
  );
}
