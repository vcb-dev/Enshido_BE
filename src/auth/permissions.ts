import { RoleCode } from '@prisma/client';

export const Permission = {
  USERS_MANAGE: 'users.manage',
} as const;

export type PermissionCode = (typeof Permission)[keyof typeof Permission];

const ALL = Object.values(Permission);

const ROLE_PERMISSIONS: Record<RoleCode, readonly PermissionCode[]> = {
  [RoleCode.ADMIN]: ALL,
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

export function userHasPermission(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[],
  permission: PermissionCode,
): boolean {
  return permissionsForRoles(roleCode, extraRoles).includes(permission);
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
  [RoleCode.USER]: 'User',
};

export function roleLabelFor(
  roleCode: RoleCode,
  extraRoles: readonly RoleCode[] = [],
): string {
  return rolesOf(roleCode, extraRoles)
    .map((r) => ROLE_LABELS[r])
    .join(' + ');
}
