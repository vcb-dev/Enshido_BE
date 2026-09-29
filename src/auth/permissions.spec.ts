import { RoleCode } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  isWorkerOnly,
  Permission,
  permissionsForUser,
  roleLabelFor,
  sanitizeScreens,
  userCan,
  userHasRole,
} from './permissions';

const KHO = Permission.SCREEN_WAREHOUSE_NVL_CHINH;

describe('permissionsForUser', () => {
  it('admin có mọi quyền, không cần tick màn hình nào', () => {
    expect(permissionsForUser(RoleCode.ADMIN, [], [])).toEqual([
      ...ALL_PERMISSIONS,
    ]);
  });

  it('admin ở extraRoles cũng có mọi quyền', () => {
    // Trước đây hàm chỉ kiểm roleCode nên tài khoản kiểu này qua được @Roles(ADMIN)
    // mà trượt mọi @RequirePermissions. Đây là bài kiểm chốt cho chỗ đã vá.
    expect(permissionsForUser(RoleCode.USER, [RoleCode.ADMIN], [])).toEqual([
      ...ALL_PERMISSIONS,
    ]);
  });

  it('nhân viên chỉ có đúng màn hình được tick', () => {
    expect(permissionsForUser(RoleCode.USER, [], [KHO])).toEqual([KHO]);
  });

  it('role Thợ tự có quyền nhận phiếu con dù không tick gì', () => {
    expect(permissionsForUser(RoleCode.WORKER, [], [])).toEqual([
      Permission.PRODUCTION_WORKER,
    ]);
  });

  it('thợ kiêm nhiệm: gộp quyền từ role và quyền màn hình, không trùng lặp', () => {
    const result = permissionsForUser(RoleCode.WORKER, [], [KHO]);
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([Permission.PRODUCTION_WORKER, KHO]),
    );
  });

  it('bỏ qua mã quyền lạ trong allowedScreens', () => {
    expect(
      permissionsForUser(RoleCode.USER, [], ['screen.khong-ton-tai']),
    ).toEqual([]);
  });
});

describe('isWorkerOnly — điểm chặn duy nhất của màn quản lý đơn', () => {
  it('đúng với tài khoản chỉ làm thợ', () => {
    expect(isWorkerOnly(RoleCode.WORKER, [])).toBe(true);
  });

  it('sai với nhân viên và admin thường', () => {
    expect(isWorkerOnly(RoleCode.USER, [])).toBe(false);
    expect(isWorkerOnly(RoleCode.ADMIN, [])).toBe(false);
  });

  it('thợ kiêm admin thì KHÔNG bị chặn', () => {
    expect(isWorkerOnly(RoleCode.WORKER, [RoleCode.ADMIN])).toBe(false);
    expect(isWorkerOnly(RoleCode.ADMIN, [RoleCode.WORKER])).toBe(false);
  });
});

describe('userHasRole', () => {
  it('nhận cả role chính lẫn role phụ', () => {
    expect(userHasRole(RoleCode.USER, [RoleCode.WORKER], RoleCode.WORKER)).toBe(
      true,
    );
    expect(userHasRole(RoleCode.USER, [], RoleCode.WORKER)).toBe(false);
  });
});

describe('sanitizeScreens', () => {
  it('lọc mã lạ và bỏ trùng', () => {
    expect(sanitizeScreens([KHO, KHO, 'linh tinh'])).toEqual([KHO]);
  });

  it('nhận null / undefined', () => {
    expect(sanitizeScreens(null)).toEqual([]);
    expect(sanitizeScreens(undefined)).toEqual([]);
  });
});

describe('roleLabelFor', () => {
  it('đặt tên tiếng Việt cho từng vai trò', () => {
    expect(roleLabelFor(RoleCode.WORKER, [])).toBe('Thợ');
    expect(roleLabelFor(RoleCode.USER, [])).toBe('Nhân viên');
    expect(roleLabelFor(RoleCode.USER, [RoleCode.ADMIN])).toBe(
      'Nhân viên + Admin',
    );
  });
});

describe('userCan — quyền theo việc', () => {
  const staff = (screens: string[]) => ({
    roleCode: RoleCode.USER,
    extraRoles: [] as RoleCode[],
    allowedScreens: screens,
  });

  it('nhân viên chưa tick quyền việc nào thì không làm được việc nào', () => {
    const user = staff([KHO]);
    for (const permission of [
      Permission.INTAKE_CREATE,
      Permission.INTAKE_APPROVE,
      Permission.PRODUCTION_MODEL3D,
      Permission.PRODUCTION_WAX,
      Permission.PRODUCTION_CAST,
      Permission.WAREHOUSE_KEEPER,
      Permission.PRODUCTION_QC,
    ]) {
      expect(userCan(user, permission)).toBe(false);
    }
  });

  it('chỉ có đúng quyền được tick, không kéo theo quyền khác', () => {
    const user = staff([Permission.PRODUCTION_CAST]);
    expect(userCan(user, Permission.PRODUCTION_CAST)).toBe(true);
    expect(userCan(user, Permission.WAREHOUSE_KEEPER)).toBe(false);
    expect(userCan(user, Permission.PRODUCTION_QC)).toBe(false);
  });

  it('nhiều quyền: chỉ cần một trong số đó', () => {
    const keeper = staff([Permission.WAREHOUSE_KEEPER]);
    const qc = staff([Permission.PRODUCTION_QC]);
    const nobody = staff([]);
    const cut = [Permission.WAREHOUSE_KEEPER, Permission.PRODUCTION_QC] as const;
    expect(userCan(keeper, ...cut)).toBe(true);
    expect(userCan(qc, ...cut)).toBe(true);
    expect(userCan(nobody, ...cut)).toBe(false);
  });

  it('admin có mọi quyền việc, kể cả khi ADMIN chỉ ở extraRoles', () => {
    expect(userCan({ roleCode: RoleCode.ADMIN }, Permission.PRODUCTION_QC)).toBe(true);
    expect(
      userCan(
        { roleCode: RoleCode.USER, extraRoles: [RoleCode.ADMIN] },
        Permission.WAREHOUSE_KEEPER,
      ),
    ).toBe(true);
  });

  it('Quản lý xưởng kiêm quản lý SX + thủ kho + KCS, không kèm việc của thợ', () => {
    const manager = staff([Permission.PRODUCTION_MANAGER]);
    for (const permission of [
      Permission.INTAKE_CREATE,
      Permission.INTAKE_APPROVE,
      Permission.WAREHOUSE_KEEPER,
      Permission.PRODUCTION_QC,
    ]) {
      expect(userCan(manager, permission)).toBe(true);
    }
    expect(userCan(manager, Permission.PRODUCTION_MODEL3D)).toBe(false);
    expect(userCan(manager, Permission.PRODUCTION_WAX)).toBe(false);
    expect(userCan(manager, Permission.PRODUCTION_CAST)).toBe(false);
  });

  it('role Thợ không tự có quyền việc nào ngoài nhận phiếu con', () => {
    const worker = { roleCode: RoleCode.WORKER, extraRoles: [] as RoleCode[] };
    expect(userCan(worker, Permission.PRODUCTION_WORKER)).toBe(true);
    expect(userCan(worker, Permission.PRODUCTION_QC)).toBe(false);
    expect(userCan(worker, Permission.WAREHOUSE_KEEPER)).toBe(false);
  });
});
