/**
 * 个人中心（`docs/03` §3.5.1「会员 / 个人中心 `/account`」）：
 * 资料、地址簿（`user_addresses`）、收藏（`user_favorites`）。
 *
 * 收藏的读端点文档未定义 → 本版只做入口占位（见 README「未实现项」），
 * **不伪造数据**。
 */

import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";

import { getCurrentUser, listAddresses, logout } from "../api/client.ts";
import { isShopHttpError } from "../api/errors.ts";
import { PageTitle } from "../components/app-shell.tsx";
import { Empty, ErrorNotice, Loading } from "../components/ui.tsx";
import { useAsync } from "../hooks/use-async.ts";

/** 个人中心页。 */
export function AccountPage(): ReactNode {
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  const loadUser = useCallback(() => getCurrentUser(), []);
  const user = useAsync(loadUser);

  // 未登录（401 / ERR_SHOP_*）时不请求地址簿，避免无意义报错。
  const needLogin = user.error !== null && isShopHttpError(user.error) && user.error.requiresLogin;
  const loadAddresses = useCallback(() => listAddresses(), []);
  const addresses = useAsync(loadAddresses, user.data !== null);

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout();
      navigate("/login");
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <section>
      <PageTitle>我的</PageTitle>

      {user.loading && <Loading />}
      {user.error !== null && !needLogin && (
        <ErrorNotice error={user.error} onRetry={user.reload} />
      )}
      {needLogin && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <p>尚未登录或登录态已过期。</p>
          <Link to="/login" className="mt-2 inline-block rounded bg-amber-600 px-3 py-1 text-white">
            去登录
          </Link>
        </div>
      )}

      {user.data !== null && (
        <div className="rounded border border-gray-200 bg-white p-4 text-sm">
          <p className="text-gray-900">昵称：{user.data.nickname ?? "未设置"}</p>
          <p className="mt-1 text-gray-500">手机号：{user.data.phoneMasked}</p>
          <button
            type="button"
            disabled={loggingOut}
            onClick={() => {
              void handleLogout();
            }}
            className="mt-3 rounded border border-gray-300 px-3 py-1 text-gray-700 disabled:opacity-40"
          >
            {loggingOut ? "退出中…" : "退出登录"}
          </button>
        </div>
      )}

      {user.data !== null && (
        <section className="mt-4">
          <h2 className="mb-2 text-sm font-medium text-gray-900">地址簿</h2>
          {addresses.loading && <Loading label="读取地址…" />}
          {addresses.error !== null && (
            <ErrorNotice error={addresses.error} onRetry={addresses.reload} />
          )}
          {addresses.data !== null && addresses.data.length === 0 && <Empty label="暂无收货地址" />}
          {addresses.data !== null && addresses.data.length > 0 && (
            <ul className="space-y-2">
              {addresses.data.map((address) => (
                <li
                  key={address.id}
                  className="rounded border border-gray-200 bg-white p-3 text-sm"
                >
                  <p className="text-gray-900">
                    {address.receiverName} {address.receiverPhone}
                    {address.isDefault && <span className="ml-2 text-xs text-blue-600">默认</span>}
                  </p>
                  <p className="mt-1 text-gray-500">
                    {address.province}
                    {address.city}
                    {address.district}
                    {address.detail}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="mt-4">
        <h2 className="mb-2 text-sm font-medium text-gray-900">我的收藏</h2>
        <Empty label="收藏功能待后端提供读端点（docs/03 §3.5.1 提到 user_favorites，端点未定义）" />
      </section>
    </section>
  );
}
