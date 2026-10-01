import { RoleCode } from '@prisma/client';

export const Permission = {
  USERS_MANAGE: 'users.manage',
  SCREEN_DASHBOARD: 'screen.dashboard',
  SCREEN_WAREHOUSE_NVL_CHINH: 'screen.warehouse.nvl-chinh',
  SCREEN_WAREHOUSE_BTP: 'screen.warehouse.btp-cho-vao-da',
  SCREEN_WAREHOUSE_TIEU_HAO: 'screen.warehouse.nvl-tieu-hao',
  SCREEN_WAREHOUSE_THANH_PHAM: 'screen.warehouse.thanh-pham',
  SCREEN_LOCATIONS: 'screen.locations',
  SCREEN_CATALOGS: 'screen.catalogs',
  /** Thợ sản xuất: tự nhận phiếu mẹ hoặc phiếu con ở màn "Phiếu của tôi". */
  PRODUCTION_WORKER: 'production.worker',
  /** Bước 1: tạo đơn. */
  INTAKE_CREATE: 'intake.create',
  /** Bước 2: quản lý sản xuất duyệt / từ chối / sửa / xoá đơn. */
  INTAKE_APPROVE: 'intake.approve',
  /** Bước 3–4: thợ 3D gắn link 3D, in sáp resin. */
  PRODUCTION_MODEL3D: 'production.model3d',
  /** Bước 5–6: thợ sáp cấy cây thông, bơm sáp. */
  PRODUCTION_WAX: 'production.wax',
  /** Bước 8–9: thợ đúc bắt đầu đúc và nhập kết quả. */
  PRODUCTION_CAST: 'production.cast',
  /** Bước 5–11: thủ kho xác nhận sáp, lên phiếu đúc, xác nhận đúc xong (cân phôi), chia phiếu, duyệt xuất NVL. */
  WAREHOUSE_KEEPER: 'warehouse.keeper',
  /** Bước 13–15, 18: KCS nhận lại hàng, chốt Lỗi / Hoàn thiện. */
  PRODUCTION_QC: 'production.qc',
  /**
   * Quản lý xưởng — một người kiêm quản lý SX + thủ kho + KCS. Tick quyền này là có đủ
   * `intake.create`, `intake.approve`, `warehouse.keeper`, `production.qc`.
   */
  PRODUCTION_MANAGER: 'production.manager',
} as const;

export type PermissionCode = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: PermissionCode[] = Object.values(Permission);

const ROLE_PERMISSIONS: Record<RoleCode, readonly PermissionCode[]> = {
  [RoleCode.ADMIN]: ALL_PERMISSIONS,
  [RoleCode.USER]: [],
  // Thợ có sẵn quyền nhận phiếu sản xuất, không phải tick tay ở màn Nhân sự.
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
    new Set(
      rolesOf(roleCode, extraRoles).flatMap((r) => permissionsForRole(r)),
    ),
  );
}

/** Các việc mà quyền Quản lý xưởng bao gồm. */
export const MANAGER_PERMISSIONS: readonly PermissionCode[] = [
  Permission.INTAKE_CREATE,
  Permission.INTAKE_APPROVE,
  Permission.WAREHOUSE_KEEPER,
  Permission.PRODUCTION_QC,
];

export function sanitizeScreens(
  screens: readonly string[] | undefined | null,
): PermissionCode[] {
  const allowed = new Set<string>(ALL_PERMISSIONS);
  return Array.from(new Set(screens ?? [])).filter(
    (key): key is PermissionCode => allowed.has(key),
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
  const granted = [
    ...permissionsForRoles(roleCode, extraRoles),
    ...sanitizeScreens(allowedScreens),
  ];
  return Array.from(
    new Set(
      granted.includes(Permission.PRODUCTION_MANAGER)
        ? [...granted, ...MANAGER_PERMISSIONS]
        : granted,
    ),
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

/** Tài khoản có ÍT NHẤT MỘT trong các quyền (admin luôn có). Dùng cho kiểm tra ở tầng service. */
export function userCan(
  user: {
    roleCode: RoleCode;
    extraRoles?: readonly RoleCode[];
    allowedScreens?: readonly string[];
  },
  ...permissions: PermissionCode[]
): boolean {
  const granted = permissionsForUser(
    user.roleCode,
    user.extraRoles ?? [],
    user.allowedScreens ?? [],
  );
  return permissions.some((permission) => granted.includes(permission));
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
