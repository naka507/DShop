/**
 * 后台入口识别（`docs/03` §3.5.2）。
 *
 * 平台后台与商户后台是**同一份构建产物**，按 `location.hostname` 在运行时分流：
 * - `admin.dshop.example.com`    → 平台入口，挂载 `/platform/*`，Token `aud=admin`
 * - `merchant.dshop.example.com` → 商户入口，挂载 `/merchant/*`，Token `aud=merchant`
 *
 * 本地开发（`localhost`）默认走平台入口，登录页可手动切换。
 *
 * **不做 UA 跳转、不做两套构建**（`docs/03` §3.5.2 硬性规则）。
 */

/** 后台入口。 */
export type AdminEntry = "platform" | "merchant";

/** 入口 → 路由 basename。 */
export const ENTRY_BASE_PATH: Record<AdminEntry, string> = {
  platform: "/platform",
  merchant: "/merchant",
};

/** 入口 → 登录接口（`docs/03` §3.5.2 表格）。 */
export const ENTRY_LOGIN_PATH: Record<AdminEntry, string> = {
  platform: "/admin/login",
  merchant: "/merchant/login",
};

/** 入口 → 当前身份接口。 */
export const ENTRY_ME_PATH: Record<AdminEntry, string> = {
  platform: "/admin/me",
  merchant: "/merchant/me",
};

/** 入口 → 界面文案。 */
export const ENTRY_LABEL: Record<AdminEntry, string> = {
  platform: "平台后台",
  merchant: "商户后台",
};

/**
 * 由 hostname 判定入口。
 *
 * 只认 `merchant.*` / `merchant-*` 前缀为商户入口，其余（含 `admin.*` 与本地
 * `localhost`）一律平台入口——与 `docs/03` §3.5.2 的域名表一致。
 */
export function detectEntry(hostname: string): AdminEntry {
  const host = hostname.toLowerCase();
  if (host.startsWith("merchant.") || host.startsWith("merchant-")) return "merchant";
  return "platform";
}
