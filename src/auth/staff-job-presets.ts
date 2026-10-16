import { ProductionStage, RoleCode } from '@prisma/client';
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
  | 'worker_filing'
  | 'worker_stone'
  | 'worker_engrave'
  | 'worker_polish'
  | 'worker_plate'
  | 'vcb'
  | 'warehouse'
  | 'kcs'
  | 'accountant';

/** Thợ khâu sau đúc — mỗi vai trò đúng một khâu, nhận phiếu ở màn Phiếu của tôi. */
const STAGE_WORKER_PRESETS = {
  worker_filing: ProductionStage.FILING,
  worker_stone: ProductionStage.STONE_SETTING,
  worker_engrave: ProductionStage.ENGRAVING,
  worker_polish: ProductionStage.POLISHING,
  worker_plate: ProductionStage.PLATING,
} as const satisfies Partial<Record<StaffJobPreset, ProductionStage>>;

type StageWorkerPreset = keyof typeof STAGE_WORKER_PRESETS;

function isStageWorkerPreset(
  preset: StaffJobPreset,
): preset is StageWorkerPreset {
  return preset in STAGE_WORKER_PRESETS;
}

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
  if (isStageWorkerPreset(preset)) {
    return {
      roleCode: RoleCode.WORKER,
      allowedScreens: [
        Permission.SCREEN_MY_TICKETS,
        Permission.PRODUCTION_WORKER,
      ],
    };
  }
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
    case 'vcb':
      // Khách VCB ngoài xưởng: chỉ lên đơn, xem và sửa đơn — mã CUSTOMER khoá mọi việc khác.
      return {
        roleCode: RoleCode.USER,
        allowedScreens: [
          Permission.SCREEN_INTAKE_ORDERS,
          Permission.INTAKE_CREATE,
          Permission.CUSTOMER,
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
    case 'accountant':
      return {
        roleCode: RoleCode.USER,
        allowedScreens: [
          Permission.SCREEN_DASHBOARD,
          Permission.SCREEN_WAREHOUSE_THANH_PHAM,
          Permission.ACCOUNTING_APPROVE,
        ],
      };
  }
}

export function workerStagesForPreset(
  preset: StaffJobPreset,
): ProductionStage[] {
  if (isStageWorkerPreset(preset)) return [STAGE_WORKER_PRESETS[preset]];
  // Thợ nhiều khâu: form Nhân sự gửi danh sách khâu tick, preset này không tự có khâu.
  if (preset === 'worker_sx') return Object.values(ProductionStage);
  return [];
}

export function inferStaffJobPreset(user: {
  roleCode: RoleCode;
  allowedScreens?: readonly string[];
  workerStages?: readonly ProductionStage[];
}): StaffJobPreset {
  if (user.roleCode === RoleCode.ADMIN) return 'admin';
  const screens = new Set(user.allowedScreens ?? []);
  const granted = permissionsForUser(
    user.roleCode,
    [],
    user.allowedScreens ?? [],
  );
  if (screens.has(Permission.CUSTOMER)) return 'vcb';
  if (user.roleCode === RoleCode.WORKER) {
    if (granted.includes(Permission.PRODUCTION_MODEL3D)) return 'worker_3d';
    if (granted.includes(Permission.PRODUCTION_WAX)) return 'worker_wax';
    if (
      screens.has(Permission.SCREEN_CASTING_ORDERS) ||
      granted.includes(Permission.PRODUCTION_CAST)
    ) {
      return 'worker_casting';
    }
    const stages = user.workerStages ?? [];
    if (stages.length === 1) {
      const match = (
        Object.keys(STAGE_WORKER_PRESETS) as StageWorkerPreset[]
      ).find((preset) => STAGE_WORKER_PRESETS[preset] === stages[0]);
      if (match) return match;
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
    granted.includes(Permission.ACCOUNTING_APPROVE) &&
    !granted.includes(Permission.WAREHOUSE_KEEPER) &&
    !granted.includes(Permission.PRODUCTION_QC)
  ) {
    return 'accountant';
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
  worker_sx: 'Thợ theo khâu (chưa chọn khâu)',
  worker_3d: 'Thợ 3D',
  worker_wax: 'Thợ sáp',
  worker_casting: 'Thợ đúc',
  worker_filing: 'Thợ nguội',
  worker_stone: 'Thợ đá',
  worker_engrave: 'Thợ khắc',
  worker_polish: 'Thợ đánh bóng',
  worker_plate: 'Thợ xi',
  vcb: 'VCB',
  warehouse: 'Thủ kho',
  kcs: 'QC',
  accountant: 'Kế toán',
};

export function staffJobLabelFor(user: {
  roleCode: RoleCode;
  allowedScreens?: readonly string[];
  workerStages?: readonly ProductionStage[];
}): string {
  const preset = inferStaffJobPreset(user);
  // Thợ theo khâu làm được nhiều khâu — nhãn ghép "Thợ đánh bóng + Thợ xi" như màn Nhân sự.
  if (preset === 'worker_sx' || isStageWorkerPreset(preset)) {
    const stages = user.workerStages ?? [];
    const labels = (Object.keys(STAGE_WORKER_PRESETS) as StageWorkerPreset[])
      .filter((key) => stages.includes(STAGE_WORKER_PRESETS[key]))
      .map((key) => STAFF_JOB_LABELS[key]);
    if (labels.length) return labels.join(' + ');
  }
  return STAFF_JOB_LABELS[preset];
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
