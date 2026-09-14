import { RoleCode } from '@prisma/client';

export const Permission = {
  USERS_MANAGE: 'users.manage',
  SCREEN_DASHBOARD: 'screen.dashboard',
  SCREEN_WAREHOUSE_NVL_CHINH: 'screen.warehouse.nvl-chinh',
  SCREEN_WAREHOUSE_BTP: 'screen.warehouse.btp-cho-vao-da',
  SCREEN_WAREHOUSE_TIEU_HAO: 'screen.warehouse.nvl-tieu-hao',
  SCREEN_LOCATIONS: 'screen.locations',
  SCREEN_CATALOGS: 'screen.catalogs',
} as const;

export type PermissionCode = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: PermissionCode[] = Object.values(Permission);

const ROLE_PERMISSIONS: Record<RoleCode, readonly PermissionCode[]> = {
  [RoleCode.ADMIN]: ALL_PERMISSIONS,
  [RoleCode.USER]: [],
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

export function permissionsForUser(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[] = [],
  allowedScreens: readonly string[] = [],
): PermissionCode[] {
  if (roleCode === RoleCode.ADMIN) return [...ALL_PERMISSIONS];
  return sanitizeScreens(allowedScreens);
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
};

export function roleLabelFor(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[] = [],
): string {
  return rolesOf(roleCode, extraRoles)
    .map((r) => ROLE_LABELS[r])
    .join(' + ');
}
