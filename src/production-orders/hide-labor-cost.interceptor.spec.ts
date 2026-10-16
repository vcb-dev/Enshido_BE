import { RoleCode } from '@prisma/client';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { canSeeCosts, withoutLaborCost } from './hide-labor-cost.interceptor';

const user = (
  roleCode: RoleCode,
  allowedScreens: string[] = [],
): AuthUserPayload => ({
  id: 'u',
  username: 'u',
  email: null,
  fullName: 'U',
  roleCode,
  extraRoles: [],
  allowedScreens,
  department: null,
});

describe('tiền công chỉ thủ kho và kế toán xem', () => {
  it('ai được xem', () => {
    expect(
      canSeeCosts(user(RoleCode.USER, [Permission.WAREHOUSE_KEEPER])),
    ).toBe(true);
    expect(
      canSeeCosts(user(RoleCode.USER, [Permission.ACCOUNTING_APPROVE])),
    ).toBe(true);
    expect(canSeeCosts(user(RoleCode.ADMIN))).toBe(true);
    expect(canSeeCosts(user(RoleCode.USER, [Permission.PRODUCTION_QC]))).toBe(
      false,
    );
    expect(canSeeCosts(user(RoleCode.WORKER))).toBe(false);
  });

  it('xoá mọi laborCost lồng nhau mà không sửa object gốc (đang nằm trong cache)', () => {
    const handedAt = new Date('2026-10-16T00:00:00Z');
    const detail = {
      code: 'A010',
      stages: [{ id: 's1', laborCost: '50000', handedAt }],
      activity: [{ before: { laborCost: '1' }, after: { laborCost: '2' } }],
    };
    const hidden = withoutLaborCost(detail);
    expect(hidden.stages[0].laborCost).toBeNull();
    expect(hidden.stages[0].handedAt).toBe(handedAt);
    expect(hidden.activity[0].before.laborCost).toBeNull();
    expect(hidden.activity[0].after.laborCost).toBeNull();
    expect(detail.stages[0].laborCost).toBe('50000');
    expect(detail.activity[0].after.laborCost).toBe('2');
  });
});
