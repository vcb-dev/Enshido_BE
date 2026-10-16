import { ForbiddenException } from '@nestjs/common';
import { ProductionStage, RoleCode } from '@prisma/client';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { assertWorkerCanView, type VisibilityOrder } from './ticket-visibility';

const actor = (
  id: string,
  roleCode: RoleCode = RoleCode.WORKER,
  allowedScreens: string[] = [],
): AuthUserPayload => ({
  id,
  username: id,
  email: null,
  fullName: id,
  roleCode,
  extraRoles: [],
  allowedScreens,
  department: null,
});

const filing = actor('nguoi');
const plating = actor('xi');
const FILING = [ProductionStage.FILING];
const PLATING = [ProductionStage.PLATING];

/** Đơn chia 2 phiếu: phiếu 1 thợ nguội đã làm và đang chờ Xi, phiếu 2 giao cho thợ khác. */
const order: VisibilityOrder = {
  pendingStage: null,
  claimedByUserId: null,
  subTickets: [
    { id: 't1', pendingStage: ProductionStage.PLATING, claimedByUserId: null },
    { id: 't2', pendingStage: ProductionStage.FILING, claimedByUserId: 'khac' },
  ],
  stages: [{ subTicketId: 't1', craftsmanUserId: 'nguoi' }],
};

describe('thợ khâu chỉ xem phiếu của mình', () => {
  it('xem được phiếu mình đã làm, không xem được phiếu giao cho người khác', () => {
    expect(() =>
      assertWorkerCanView(order, filing, FILING, 't1'),
    ).not.toThrow();
    expect(() => assertWorkerCanView(order, filing, FILING, 't2')).toThrow(
      ForbiddenException,
    );
  });

  it('xem được phiếu đang chờ đúng khâu của mình mà chưa ai nhận', () => {
    expect(() =>
      assertWorkerCanView(order, plating, PLATING, 't1'),
    ).not.toThrow();
    expect(() => assertWorkerCanView(order, plating, PLATING, 't2')).toThrow(
      ForbiddenException,
    );
  });

  it('thợ được chỉ định xem được phiếu dù khâu chưa bắt đầu', () => {
    expect(() =>
      assertWorkerCanView(order, actor('khac'), FILING, 't2'),
    ).not.toThrow();
  });

  it('thông tin đơn: chỉ cần một phiếu trong đơn là của mình', () => {
    expect(() => assertWorkerCanView(order, filing, FILING)).not.toThrow();
    expect(() =>
      assertWorkerCanView(order, actor('la'), [ProductionStage.ENGRAVING]),
    ).toThrow(ForbiddenException);
  });

  it('phiếu mẹ (đơn chưa chia) theo cùng luật', () => {
    const parent: VisibilityOrder = {
      pendingStage: ProductionStage.POLISHING,
      claimedByUserId: null,
      subTickets: [],
      stages: [],
    };
    expect(() =>
      assertWorkerCanView(parent, actor('bong'), [ProductionStage.POLISHING]),
    ).not.toThrow();
    expect(() => assertWorkerCanView(parent, filing, FILING)).toThrow(
      ForbiddenException,
    );
  });

  it('QC, thợ đúc và admin không bị luật này chặn', () => {
    for (const viewer of [
      actor('qc', RoleCode.USER, [Permission.PRODUCTION_QC]),
      actor('duc', RoleCode.WORKER, [Permission.PRODUCTION_CAST]),
      actor('admin', RoleCode.ADMIN),
    ]) {
      expect(() => assertWorkerCanView(order, viewer, [], 't2')).not.toThrow();
    }
  });
});
