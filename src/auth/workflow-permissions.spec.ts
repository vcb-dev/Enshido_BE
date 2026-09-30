import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleCode } from '@prisma/client';
import { CastingCutsController } from '../casting-cuts/casting-cuts.controller';
import { CastingSlipsController } from '../casting-slips/casting-slips.controller';
import { IntakeOrdersController } from '../intake-orders/intake-orders.controller';
import { ProductionOrdersController } from '../production-orders/production-orders.controller';
import { PermissionsGuard } from './guards/permissions.guard';
import { WorkerRestrictedGuard } from './guards/worker-restricted.guard';
import { MANAGER_PERMISSIONS, Permission, type PermissionCode } from './permissions';
import type { AuthUserPayload } from './types';

const P = Permission;
const KEEPER_OR_QC = [P.WAREHOUSE_KEEPER, P.PRODUCTION_QC];

/** Endpoint → các quyền được phép (chỉ cần một). Khớp cột "Người thực hiện" trong file mô tả luồng. */
const MATRIX: [string, object, string, PermissionCode[]][] = [
  ['B1 tạo đơn', IntakeOrdersController.prototype, 'create', [P.INTAKE_CREATE]],
  ['B2 duyệt đơn', IntakeOrdersController.prototype, 'approve', [P.INTAKE_APPROVE]],
  ['B2 từ chối đơn', IntakeOrdersController.prototype, 'reject', [P.INTAKE_APPROVE]],
  ['sửa đơn', IntakeOrdersController.prototype, 'update', [P.INTAKE_CREATE, P.INTAKE_APPROVE]],
  ['xoá đơn', IntakeOrdersController.prototype, 'remove', [P.INTAKE_APPROVE]],
  ['B3 gắn link 3D', IntakeOrdersController.prototype, 'attachModel3d', [P.PRODUCTION_MODEL3D]],
  ['B4 in sáp nhiều đơn', IntakeOrdersController.prototype, 'submitWaxPrintBatch', [P.PRODUCTION_MODEL3D]],
  ['B4 in sáp nhiều đơn (ảnh khay)', IntakeOrdersController.prototype, 'waxPrintBatch', [P.PRODUCTION_MODEL3D]],
  ['B4/B6 số liệu sáp', IntakeOrdersController.prototype, 'submitProductSpecs', [P.PRODUCTION_MODEL3D, P.PRODUCTION_WAX]],
  ['B5 cây thông', IntakeOrdersController.prototype, 'submitCastingTreeSpecs', [P.PRODUCTION_WAX]],
  ['B5/B6 thủ kho xác nhận sáp', IntakeOrdersController.prototype, 'confirmWarehouse', [P.WAREHOUSE_KEEPER]],
  ['B9 hao hụt đúc theo thợ', CastingSlipsController.prototype, 'lossByWorker', [P.WAREHOUSE_KEEPER]],
  ['B7 lọc đơn chờ đúc', CastingSlipsController.prototype, 'candidates', [P.WAREHOUSE_KEEPER]],
  ['B7 lên phiếu đúc nhiều đơn', CastingSlipsController.prototype, 'create', [P.WAREHOUSE_KEEPER]],
  ['B7 chụp ảnh cấp vật tư → F', CastingSlipsController.prototype, 'issue', [P.WAREHOUSE_KEEPER]],
  ['B7 huỷ phiếu chưa cấp', CastingSlipsController.prototype, 'remove', [P.WAREHOUSE_KEEPER]],
  ['B7 in phiếu đúc', CastingSlipsController.prototype, 'markPrinted', [P.WAREHOUSE_KEEPER]],
  ['B8 bắt đầu đúc', CastingSlipsController.prototype, 'start', [P.PRODUCTION_CAST]],
  ['B9 nhập kết quả đúc', CastingSlipsController.prototype, 'submitResult', [P.PRODUCTION_CAST]],
  ['B9 thủ kho xác nhận đúc', CastingSlipsController.prototype, 'confirm', [P.WAREHOUSE_KEEPER]],
  ['B10 cắt cây', CastingCutsController.prototype, 'create', KEEPER_OR_QC],
  ['B10 xoá phiếu cắt', CastingCutsController.prototype, 'remove', KEEPER_OR_QC],
  ['B10 đánh dấu đã in', CastingCutsController.prototype, 'markPrinted', KEEPER_OR_QC],
  ['B13 KCS nhận lại khâu', ProductionOrdersController.prototype, 'returnStage', [P.PRODUCTION_QC]],
  ['B14–15 KCS ghi lỗi phiếu con', ProductionOrdersController.prototype, 'defectSubTicket', [P.PRODUCTION_QC]],
  ['B14–15 KCS hoàn thiện phiếu con', ProductionOrdersController.prototype, 'finishSubTicket', [P.PRODUCTION_QC]],
  ['KCS hoàn thiện đơn', ProductionOrdersController.prototype, 'finish', [P.PRODUCTION_QC]],
  ['kho xuất NVL cho thợ', ProductionOrdersController.prototype, 'issueMaterialRequest', [P.WAREHOUSE_KEEPER]],
  ['kho từ chối xin NVL', ProductionOrdersController.prototype, 'rejectMaterialRequest', [P.WAREHOUSE_KEEPER]],
];

function user(
  roleCode: RoleCode,
  allowedScreens: string[] = [],
): AuthUserPayload {
  return {
    id: 'u1',
    username: 'u',
    email: null,
    fullName: 'U',
    roleCode,
    extraRoles: [],
    allowedScreens,
    department: null,
  };
}

function contextFor(proto: object, method: string, actor: AuthUserPayload) {
  const handler = (proto as Record<string, () => unknown>)[method];
  const controller = (proto as { constructor: () => unknown }).constructor;
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: actor }) }),
  } as unknown as ExecutionContext;
}

describe('quyền theo việc trên từng endpoint', () => {
  const guard = new PermissionsGuard(new Reflector());
  const allPermissions = Object.values(P) as PermissionCode[];

  it.each(MATRIX)('%s', (_label, proto, method, allowed) => {
    // Đúng quyền → qua, mỗi quyền trong danh sách đều đủ.
    for (const permission of allowed) {
      expect(
        guard.canActivate(contextFor(proto, method, user(RoleCode.USER, [permission]))),
      ).toBe(true);
    }
    // Quản lý xưởng gồm quản lý SX + thủ kho + KCS: qua được đúng các việc đó, không qua việc của thợ.
    const managerAllowed = allowed.some((permission) => MANAGER_PERMISSIONS.includes(permission));
    const asManager = contextFor(proto, method, user(RoleCode.USER, [P.PRODUCTION_MANAGER]));
    if (managerAllowed) expect(guard.canActivate(asManager)).toBe(true);
    else expect(() => guard.canActivate(asManager)).toThrow(ForbiddenException);
    // Có mọi quyền khác nhưng thiếu quyền của việc này → bị chặn.
    const others = allPermissions.filter(
      (permission) =>
        !allowed.includes(permission) &&
        !(managerAllowed && permission === P.PRODUCTION_MANAGER),
    );
    expect(() =>
      guard.canActivate(contextFor(proto, method, user(RoleCode.USER, others))),
    ).toThrow(ForbiddenException);
    // Không có quyền nào → bị chặn.
    expect(() =>
      guard.canActivate(contextFor(proto, method, user(RoleCode.USER, []))),
    ).toThrow(ForbiddenException);
    // Admin luôn qua.
    expect(guard.canActivate(contextFor(proto, method, user(RoleCode.ADMIN)))).toBe(true);
  });
});

describe('tài khoản chỉ làm thợ không gọi được việc của KCS / thủ kho / văn phòng', () => {
  const guard = new WorkerRestrictedGuard(new Reflector());
  const worker = user(RoleCode.WORKER, [P.PRODUCTION_QC, P.WAREHOUSE_KEEPER]);

  it.each(MATRIX)('%s', (_label, proto, method) => {
    // Kể cả bị tick nhầm quyền việc, thợ vẫn bị @BlockWorker chặn.
    expect(() => guard.canActivate(contextFor(proto, method, worker))).toThrow(
      ForbiddenException,
    );
  });

  it('thợ kiêm admin thì không bị chặn', () => {
    const both: AuthUserPayload = { ...worker, extraRoles: [RoleCode.ADMIN] };
    expect(
      guard.canActivate(
        contextFor(ProductionOrdersController.prototype, 'returnStage', both),
      ),
    ).toBe(true);
  });
});
