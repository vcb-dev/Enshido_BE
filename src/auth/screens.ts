import {
  Permission,
  type PermissionCode,
  userHasPermission,
} from './permissions';
import { RoleCode } from '@prisma/client';

export const WAREHOUSE_SCREEN: Record<string, PermissionCode> = {
  'nvl-chinh': Permission.SCREEN_WAREHOUSE_NVL_CHINH,
  'btp-cho-vao-da': Permission.SCREEN_WAREHOUSE_BTP,
  'nvl-tieu-hao': Permission.SCREEN_WAREHOUSE_TIEU_HAO,
  'thanh-pham': Permission.SCREEN_WAREHOUSE_THANH_PHAM,
};

export const DEFAULT_WAREHOUSE_MANAGER_SCREENS: PermissionCode[] = [
  Permission.SCREEN_DASHBOARD,
  Permission.SCREEN_WAREHOUSE_NVL_CHINH,
  Permission.SCREEN_WAREHOUSE_BTP,
  Permission.SCREEN_WAREHOUSE_TIEU_HAO,
  Permission.SCREEN_WAREHOUSE_THANH_PHAM,
  Permission.SCREEN_LOCATIONS,
];

export const DEFAULT_ACCOUNTANT_SCREENS: PermissionCode[] = [
  Permission.SCREEN_DASHBOARD,
  Permission.SCREEN_WAREHOUSE_NVL_CHINH,
  Permission.SCREEN_WAREHOUSE_BTP,
  Permission.SCREEN_WAREHOUSE_TIEU_HAO,
  Permission.SCREEN_WAREHOUSE_THANH_PHAM,
];

export const DEFAULT_STAFF_SCREENS: PermissionCode[] = [
  Permission.SCREEN_DASHBOARD,
  Permission.SCREEN_WAREHOUSE_NVL_CHINH,
  Permission.SCREEN_WAREHOUSE_BTP,
  Permission.SCREEN_WAREHOUSE_TIEU_HAO,
  Permission.SCREEN_WAREHOUSE_THANH_PHAM,
];

export function canSeeWarehouse(
  user: {
    roleCode: RoleCode;
    extraRoles?: RoleCode[];
    allowedScreens?: string[];
  },
  warehouseCode: string,
) {
  if (user.roleCode === RoleCode.ADMIN) return true;
  const permission = WAREHOUSE_SCREEN[warehouseCode];
  if (!permission) return false;
  return userHasPermission(
    user.roleCode,
    user.extraRoles ?? [],
    permission,
    user.allowedScreens ?? [],
  );
}
