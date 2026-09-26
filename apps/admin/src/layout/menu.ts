/**
 * 后台菜单定义（`docs/03` §3.5.2）。
 *
 * 菜单**按权限点过滤**（菜单级可见性），按钮级可见性由各页面用 `usePermission()` 控制。
 * 权限点常量取自 `packages/shared/src/rbac.ts`，前后端同源。
 *
 * ★ `docs/03` §3.5.2 明确：**平台后台含两个 PiEcho 专属菜单**
 * ——「Agent 令牌管理」（`agent:token:manage`）与「售后政策发布」（`aftersale:policy:manage`），
 * 这是角色 A 的运营入口，属 M0/M1 交付。
 */

import { PERMISSIONS } from "@dshop/shared";
import type { Permission } from "@dshop/shared";

/** 菜单项。 */
export interface MenuItem {
  /** 路由 path（相对入口 basename）。 */
  readonly path: string;
  /** 显示名。 */
  readonly label: string;
  /** 需要的权限点；缺省表示所有已登录后台账号可见。 */
  readonly permission?: Permission;
  /** 是否仅平台入口可见（商户入口不显示）。 */
  readonly platformOnly?: boolean;
  /** 排序权重。 */
  readonly order: number;
}

/**
 * 菜单清单。
 *
 * 顺序：PiEcho 运营入口置前（本版第一职责），其余按交易链路排。
 */
export const MENU_ITEMS: readonly MenuItem[] = [
  {
    path: "/agent-tokens",
    label: "Agent 令牌管理",
    permission: PERMISSIONS.AGENT_TOKEN_MANAGE,
    platformOnly: true,
    order: 10,
  },
  {
    path: "/aftersale-policies",
    label: "售后政策管理",
    permission: PERMISSIONS.AFTERSALE_POLICY_MANAGE,
    platformOnly: true,
    order: 20,
  },
  { path: "/orders", label: "订单管理", order: 30 },
  { path: "/aftersales", label: "售后单", order: 40 },
  { path: "/products", label: "商品", order: 50 },
  { path: "/categories", label: "分类", order: 60 },
  { path: "/merchants", label: "商户", order: 70 },
  { path: "/stores", label: "门店", order: 80 },
];

/**
 * 按「已登录 + 权限点 + 入口」过滤菜单。
 *
 * @param hasPermission 权限判定函数（来自 `usePermission().has`）
 * @param isPlatform    当前是否平台入口
 */
export function visibleMenuItems(
  hasPermission: (permission: Permission) => boolean,
  isPlatform: boolean,
): readonly MenuItem[] {
  return MENU_ITEMS.filter((item) => {
    if (item.platformOnly === true && !isPlatform) return false;
    if (item.permission === undefined) return true;
    return hasPermission(item.permission);
  }).sort((a, b) => a.order - b.order);
}

/** 按路径找菜单项（用于页面标题与面包屑）。 */
export function findMenuItem(path: string): MenuItem | undefined {
  return MENU_ITEMS.find((item) => item.path === path);
}
