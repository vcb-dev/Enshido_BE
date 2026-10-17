import { ProductionStage, RoleCode } from '@prisma/client';
import {
  Permission,
  type PermissionCode,
  isProductionStageWorker,
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
          Permission.SCREEN_CASTING_CUTS,
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
          Permission.SCREEN_QC_TICKETS,
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

/**
 * Mọi vai trò của một tài khoản, theo thứ tự cố định (Admin, thợ 3D / sáp / đúc, thợ theo khâu,
 * Thủ kho, QC, Kế toán). Một người có thể kiêm nhiều vai trò: vai trò việc đọc từ quyền đã lưu
 * (`allowedScreens` — admin cũng lưu cột này dù có mọi quyền), thợ khâu đọc từ `workerStages`.
 * Khách VCB bị khoá riêng nên luôn đứng một mình.
 */
export function inferStaffJobPresets(user: {
  roleCode: RoleCode;
  extraRoles?: readonly RoleCode[];
  allowedScreens?: readonly string[];
  workerStages?: readonly ProductionStage[];
}): StaffJobPreset[] {
  const screens = new Set(user.allowedScreens ?? []);
  const admin = userHasRole(
    user.roleCode,
    user.extraRoles ?? [],
    RoleCode.ADMIN,
  );
  if (!admin && screens.has(Permission.CUSTOMER)) return ['vcb'];
  const worker = user.roleCode === RoleCode.WORKER;

  const found: StaffJobPreset[] = admin ? ['admin'] : [];
  if (screens.has(Permission.PRODUCTION_MODEL3D)) found.push('worker_3d');
  if (screens.has(Permission.PRODUCTION_WAX)) found.push('worker_wax');
  if (
    screens.has(Permission.PRODUCTION_CAST) ||
    (worker && screens.has(Permission.SCREEN_CASTING_ORDERS))
  ) {
    found.push('worker_casting');
  }
  const stages = user.workerStages ?? [];
  const stagePresets = (
    Object.keys(STAGE_WORKER_PRESETS) as StageWorkerPreset[]
  ).filter((preset) => stages.includes(STAGE_WORKER_PRESETS[preset]));
  found.push(...stagePresets);
  // Tài khoản Thợ cũ chưa gán khâu nào.
  if (worker && !stagePresets.length && found.length === 0) {
    found.push('worker_sx');
  }
  if (screens.has(Permission.WAREHOUSE_KEEPER)) found.push('warehouse');
  if (screens.has(Permission.PRODUCTION_QC)) found.push('kcs');
  if (screens.has(Permission.ACCOUNTING_APPROVE)) found.push('accountant');
  if (found.length > 0) return found;
  // Nhân viên cũ chỉ có màn Tổng quan = QC (màn Nhân sự cũng đổi Nhân viên cũ sang QC).
  return [
    screens.size === 1 && screens.has(Permission.SCREEN_DASHBOARD)
      ? 'kcs'
      : 'staff',
  ];
}

/** Vai trò chính (đầu danh sách) — giữ cho nơi chỉ cần một vai trò. */
export function inferStaffJobPreset(user: {
  roleCode: RoleCode;
  extraRoles?: readonly RoleCode[];
  allowedScreens?: readonly string[];
  workerStages?: readonly ProductionStage[];
}): StaffJobPreset {
  return inferStaffJobPresets(user)[0];
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
  extraRoles?: readonly RoleCode[];
  allowedScreens?: readonly string[];
  workerStages?: readonly ProductionStage[];
}): string {
  // Nhiều vai trò thì ghép "Thủ kho + QC + Thợ nguội"; thợ nhiều khâu ghép theo thứ tự luồng.
  return inferStaffJobPresets(user)
    .map((preset) => STAFF_JOB_LABELS[preset])
    .join(' + ');
}

/**
 * Giao phiếu đúc — nhân sự có vai trò Thợ đúc (kể cả khi kiêm vai trò khác, kể cả admin được
 * gán vai trò này). Không gồm admin / thủ kho không có vai trò Thợ đúc.
 */
export function isCastWorkerAssignee(user: {
  roleCode: RoleCode;
  extraRoles?: readonly RoleCode[];
  allowedScreens?: readonly string[];
}): boolean {
  return inferStaffJobPresets(user).includes('worker_casting');
}

export { isProductionStageWorker };
