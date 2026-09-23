import { RoleCode } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  isWorkerOnly,
  Permission,
  permissionsForUser,
  roleLabelFor,
  sanitizeScreens,
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
