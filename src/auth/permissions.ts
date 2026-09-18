import { RoleCode } from '@prisma/client';

export const Permission = {
  USERS_MANAGE: 'users.manage',
  SCREEN_DASHBOARD: 'screen.dashboard',
  SCREEN_WAREHOUSE_NVL_CHINH: 'screen.warehouse.nvl-chinh',
  SCREEN_WAREHOUSE_BTP: 'screen.warehouse.btp-cho-vao-da',
  SCREEN_WAREHOUSE_TIEU_HAO: 'screen.warehouse.nvl-tieu-hao',
  SCREEN_LOCATIONS: 'screen.locations',
  SCREEN_CATALOGS: 'screen.catalogs',
  /** Thợ sản xuất: tự nhận phiếu con ở màn "Phiếu của tôi". */
  PRODUCTION_WORKER: 'production.worker',
} as const;

export type PermissionCode = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: PermissionCode[] = Object.values(Permission);

const ROLE_PERMISSIONS: Record<RoleCode, readonly PermissionCode[]> = {
  [RoleCode.ADMIN]: ALL_PERMISSIONS,
  [RoleCode.USER]: [],
  // Thợ có sẵn quyền nhận phiếu con, không phải tick tay ở màn Nhân sự.
  [RoleCode.WORKER]: [Permission.PRODUCTION_WORKER],
};

export function rolesOf(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[] = [],
): RoleCode[] {
  return Array.from(new Set([roleCode, ...extraRoles]));
}

export function permissionsForRole(role: RoleCode): PermissionCode[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

export function permissionsForRoles(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[] = [],
): PermissionCode[] {
  return Array.from(
    new Set(rolesOf(roleCode, extraRoles).flatMap((r) => permissionsForRole(r))),
  );
}

export function sanitizeScreens(
  screens: readonly string[] | undefined | null,
): PermissionCode[] {
  const allowed = new Set<string>(ALL_PERMISSIONS);
  return Array.from(new Set(screens ?? [])).filter((key): key is PermissionCode =>
    allowed.has(key),
  );
}

/**
 * Quyền thực tế của một tài khoản: gộp quyền kèm theo role và quyền màn hình được tick.
 * Admin có mọi quyền, kể cả khi ADMIN chỉ nằm ở `extraRoles`.
 */
export function permissionsForUser(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[] = [],
  allowedScreens: readonly string[] = [],
): PermissionCode[] {
  if (userHasRole(roleCode, extraRoles, RoleCode.ADMIN)) {
    return [...ALL_PERMISSIONS];
  }
  return Array.from(
    new Set([
      ...permissionsForRoles(roleCode, extraRoles),
      ...sanitizeScreens(allowedScreens),
    ]),
  );
}

export function userHasPermission(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[],
  permission: PermissionCode,
  allowedScreens: readonly string[] = [],
): boolean {
  return permissionsForUser(roleCode, extraRoles, allowedScreens).includes(
    permission,
  );
}

export function userHasRole(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[],
  target: RoleCode,
): boolean {
  return rolesOf(roleCode, extraRoles).includes(target);
}

export const ROLE_LABELS: Record<RoleCode, string> = {
  [RoleCode.ADMIN]: 'Admin',
  [RoleCode.USER]: 'Nhân viên',
  [RoleCode.WORKER]: 'Thợ',
};

/**
 * Tài khoản chỉ làm thợ — dùng để CHẶN các màn quản lý đơn. Hệ quyền màn hình chỉ biết
 * "cho thêm" nên việc cấm phải hỏi tường minh ở đây. Thợ kiêm admin thì không bị chặn.
 */
export function isWorkerOnly(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[] = [],
): boolean {
  return (
    userHasRole(roleCode, extraRoles, RoleCode.WORKER) &&
    !userHasRole(roleCode, extraRoles, RoleCode.ADMIN)
  );
}

export function roleLabelFor(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[] = [],
): string {
  return rolesOf(roleCode, extraRoles)
    .map((r) => ROLE_LABELS[r])
    .join(' + ');
}
