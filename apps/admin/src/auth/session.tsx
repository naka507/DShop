/**
 * RBAC 会话上下文（`docs/09` §9.2）。
 *
 * 权限点定义**同源于 `packages/shared/src/rbac.ts`**——前后端共用同一份清单，
 * 前端据此渲染菜单与按钮，后端 `requirePerm()` 做接口级拦截。**前端隐藏不等于后端放行**，
 * 二者是「可见性」与「授权」两层，缺一不可。
 *
 * 本文件提供：
 * - `SessionProvider`：持有当前登录主体（含 `permissions`）
 * - `useSession()`：取主体
 * - `usePermission()`：**按钮级**判定（`has(perm)` / `hasAny` / `hasAll`）
 * - `useMenuPermission()`：**菜单级**判定（`canSeeMenu(key)`）
 */

import { PERMISSIONS } from "@dshop/shared";
import type { Permission } from "@dshop/shared";
import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import type { AdminSubject } from "../api/types.js";

/** 会话上下文值。 */
export interface SessionContextValue {
  /** 当前登录主体；未登录为 `null`。 */
  readonly subject: AdminSubject | null;
  /** 登录成功后写入主体。 */
  readonly signIn: (subject: AdminSubject) => void;
  /** 退出登录后清空主体。 */
  readonly signOut: () => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

/** 会话 Provider。 */
export function SessionProvider(props: {
  readonly subject: AdminSubject | null;
  readonly onSignIn: (subject: AdminSubject) => void;
  readonly onSignOut: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const { subject, onSignIn, onSignOut, children } = props;
  const value = useMemo<SessionContextValue>(
    () => ({ subject, signIn: onSignIn, signOut: onSignOut }),
    [subject, onSignIn, onSignOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** 取会话上下文；必须在 `SessionProvider` 内使用。 */
export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("useSession() 必须在 <SessionProvider> 内使用");
  }
  return value;
}

/** 权限判定结果。 */
export interface PermissionApi {
  /** 是否拥有**某**权限点（按钮级控制的主要入口）。 */
  readonly has: (permission: Permission) => boolean;
  /** 是否拥有**任一**权限点。 */
  readonly hasAny: (permissions: readonly Permission[]) => boolean;
  /** 是否拥有**全部**权限点。 */
  readonly hasAll: (permissions: readonly Permission[]) => boolean;
  /** 当前主体的权限点集合（只读）。 */
  readonly permissions: readonly Permission[];
  /** 是否已登录。 */
  readonly authenticated: boolean;
}

/**
 * 按钮级权限 hook。
 *
 * 权限点取值来自 `packages/shared` 的 `PERMISSIONS`，例如
 * `has(PERMISSIONS.AFTERSALE_POLICY_MANAGE)` 控制「新建政策」按钮可见性。
 *
 * 未登录或权限点缺失一律返回 `false`（**默认拒绝**）。
 */
export function usePermission(): PermissionApi {
  const { subject } = useSession();

  const permissions = useMemo<readonly Permission[]>(
    () => (subject?.permissions ?? []) as readonly Permission[],
    [subject],
  );

  const has = useCallback(
    (permission: Permission): boolean => permissions.includes(permission),
    [permissions],
  );

  const hasAny = useCallback(
    (wanted: readonly Permission[]): boolean => wanted.some((p) => permissions.includes(p)),
    [permissions],
  );

  const hasAll = useCallback(
    (wanted: readonly Permission[]): boolean => wanted.every((p) => permissions.includes(p)),
    [permissions],
  );

  return useMemo(
    () => ({
      has,
      hasAny,
      hasAll,
      permissions,
      authenticated: subject !== null,
    }),
    [has, hasAny, hasAll, permissions, subject],
  );
}

/** 权限点常量 re-export，便于页面 `PERMISSIONS.AFTERSALE_POLICY_MANAGE` 直接用。 */
export { PERMISSIONS };
export type { Permission };
