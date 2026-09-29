import { RoleCode } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { Permission, userHasPermission, userHasRole } from '../auth/permissions';

/** Mặc định: admin hoặc user có quyền ít nhất một màn kho (thủ kho). */
const WAREHOUSE_KEEPER_PERMISSIONS = [
  Permission.SCREEN_WAREHOUSE_NVL_CHINH,
  Permission.SCREEN_WAREHOUSE_BTP,
  Permission.SCREEN_WAREHOUSE_TIEU_HAO,
  Permission.SCREEN_WAREHOUSE_THANH_PHAM,
] as const;

export function canConfirmIntakeWarehouse(user: AuthUserPayload): boolean {
  if (userHasRole(user.roleCode, user.extraRoles, RoleCode.ADMIN)) {
    return true;
  }
  const screens = user.allowedScreens ?? [];
  return WAREHOUSE_KEEPER_PERMISSIONS.some((permission) =>
    userHasPermission(user.roleCode, user.extraRoles, permission, screens),
  );
}
