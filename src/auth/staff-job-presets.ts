import { RoleCode } from '@prisma/client';
import {
  Permission,
  type PermissionCode,
  isProductionStageWorker,
  permissionsForUser,
  userHasRole,
} from './permissions';

/** Vai trò nghiệp vụ trên màn Nhân sự — map xuống roleCode + allowedScreens. */
export type StaffJobPreset =
  | 'admin'
  | 'staff'
  | 'worker_sx'
  | 'worker_3d'
  | 'worker_wax'
  | 'worker_casting'
  | 'warehouse'
  | 'kcs';

const WAREHOUSE_SCREENS: PermissionCode[] = [
  Permission.SCREEN_WAREHOUSE_NVL_CHINH,
  Permission.SCREEN_WAREHOUSE_BTP,
  Permission.SCREEN_WAREHOUSE_TIEU_HAO,
  Permission.SCREEN_WAREHOUSE_THANH_PHAM,
];

export function roleAndScreensForPreset(preset: StaffJobPreset): {
  roleCode: RoleCode;
  allowedScreens: PermissionCode[];
} {
  switch (preset) {
    case 'admin':
      return { roleCode: RoleCode.ADMIN, allowedScreens: [] };
    case 'staff':
      return { roleCode: RoleCode.USER, allowedScreens: [] };
    case 'worker_sx':
      return {
        roleCode: RoleCode.WORKER,
        allowedScreens: [
          Permission.SCREEN_MY_TICKETS,
          Permission.PRODUCTION_WORKER,
        ],
      };
    case 'worker_3d':
      return {
        roleCode: RoleCode.WORKER,
        allowedScreens: [Permission.PRODUCTION_MODEL3D],
      };
    case 'worker_wax':
      return {
        roleCode: RoleCode.WORKER,
        allowedScreens: [Permission.PRODUCTION_WAX],
      };
    case 'worker_casting':
      return {
        roleCode: RoleCode.WORKER,
        allowedScreens: [
          Permission.PRODUCTION_CAST,
          Permission.SCREEN_CASTING_ORDERS,
          Permission.SCREEN_MY_TICKETS,
        ],
      };
    case 'warehouse':
      return {
        roleCode: RoleCode.USER,
        allowedScreens: [
          ...WAREHOUSE_SCREENS,
          Permission.SCREEN_PRODUCTION_ORDERS,
          Permission.WAREHOUSE_KEEPER,
          Permission.INTAKE_CREATE,
          Permission.INTAKE_APPROVE,
        ],
      };
    case 'kcs':
      return {
        roleCode: RoleCode.USER,
        allowedScreens: [
          Permission.SCREEN_DASHBOARD,
          Permission.SCREEN_PRODUCTION_ORDERS,
          Permission.PRODUCTION_QC,
        ],
      };
  }
}

export function inferStaffJobPreset(user: {
  roleCode: RoleCode;
  allowedScreens?: readonly string[];
}): StaffJobPreset {
  if (user.roleCode === RoleCode.ADMIN) return 'admin';
  const screens = new Set(user.allowedScreens ?? []);
  const granted = permissionsForUser(
    user.roleCode,
    [],
    user.allowedScreens ?? [],
  );
  if (user.roleCode === RoleCode.WORKER) {
    if (granted.includes(Permission.PRODUCTION_MODEL3D)) return 'worker_3d';
    if (granted.includes(Permission.PRODUCTION_WAX)) return 'worker_wax';
    if (
      screens.has(Permission.SCREEN_CASTING_ORDERS) ||
      granted.includes(Permission.PRODUCTION_CAST)
    ) {
      return 'worker_casting';
    }
    return 'worker_sx';
  }
  if (screens.size === 1 && screens.has(Permission.SCREEN_DASHBOARD)) {
    return 'kcs';
  }
  if (
    granted.includes(Permission.PRODUCTION_QC) &&
    screens.has(Permission.SCREEN_DASHBOARD)
  ) {
    return 'kcs';
  }
  if (
    granted.includes(Permission.WAREHOUSE_KEEPER) &&
    WAREHOUSE_SCREENS.some((key) => screens.has(key)) &&
    !granted.includes(Permission.PRODUCTION_MODEL3D) &&
    !granted.includes(Permission.PRODUCTION_WAX)
  ) {
    return 'warehouse';
  }
  return 'staff';
}

const STAFF_JOB_LABELS: Record<StaffJobPreset, string> = {
  admin: 'Admin',
  staff: 'Nhân viên',
  worker_sx: 'Thợ sản xuất',
  worker_3d: 'Thợ 3D',
  worker_wax: 'Thợ sáp',
  worker_casting: 'Thợ đúc',
  warehouse: 'Thủ kho',
  kcs: 'QC',
};

export function staffJobLabelFor(user: {
  roleCode: RoleCode;
  allowedScreens?: readonly string[];
}): string {
  return STAFF_JOB_LABELS[inferStaffJobPreset(user)];
}

/** Giao phiếu đúc — chỉ vai trò Thợ đúc (không gồm admin / thủ kho / nhân viên tick lẻ quyền đúc). */
export function isCastWorkerAssignee(user: {
  roleCode: RoleCode;
  extraRoles?: readonly RoleCode[];
  allowedScreens?: readonly string[];
}): boolean {
  if (userHasRole(user.roleCode, user.extraRoles ?? [], RoleCode.ADMIN)) {
    return false;
  }
  return inferStaffJobPreset(user) === 'worker_casting';
}

export { isProductionStageWorker };
