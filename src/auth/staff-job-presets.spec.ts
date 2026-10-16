import { ProductionStage, RoleCode } from '@prisma/client';
import { Permission } from './permissions';
import {
  inferStaffJobPreset,
  roleAndScreensForPreset,
  staffJobLabelFor,
  workerStagesForPreset,
} from './staff-job-presets';

describe('vai trò thợ theo khâu', () => {
  it.each([
    ['worker_filing', ProductionStage.FILING, 'Thợ nguội'],
    ['worker_stone', ProductionStage.STONE_SETTING, 'Thợ đá'],
    ['worker_engrave', ProductionStage.ENGRAVING, 'Thợ khắc'],
    ['worker_polish', ProductionStage.POLISHING, 'Thợ đánh bóng'],
    ['worker_plate', ProductionStage.PLATING, 'Thợ xi'],
  ] as const)('%s chỉ làm khâu %s', (preset, stage, label) => {
    expect(workerStagesForPreset(preset)).toEqual([stage]);
    const { roleCode, allowedScreens } = roleAndScreensForPreset(preset);
    expect(roleCode).toBe(RoleCode.WORKER);
    expect(allowedScreens).toContain(Permission.PRODUCTION_WORKER);
    const user = { roleCode, allowedScreens, workerStages: [stage] };
    expect(inferStaffJobPreset(user)).toBe(preset);
    expect(staffJobLabelFor(user)).toBe(label);
  });

  it('thợ làm nhiều khâu: nhãn ghép tên thợ từng khâu theo thứ tự luồng', () => {
    const user = {
      roleCode: RoleCode.WORKER,
      allowedScreens: [],
      workerStages: [ProductionStage.PLATING, ProductionStage.POLISHING],
    };
    expect(staffJobLabelFor(user)).toBe('Thợ đánh bóng + Thợ xi');
  });
});

describe('vai trò VCB', () => {
  it('chỉ có màn Tạo đơn và quyền tạo đơn', () => {
    const { roleCode, allowedScreens } = roleAndScreensForPreset('vcb');
    expect(roleCode).toBe(RoleCode.USER);
    expect(allowedScreens).toEqual([
      Permission.SCREEN_INTAKE_ORDERS,
      Permission.INTAKE_CREATE,
      Permission.CUSTOMER,
    ]);
    expect(staffJobLabelFor({ roleCode, allowedScreens })).toBe('VCB');
  });

  it('nhân viên chỉ có quyền tạo đơn (không có mã khách) không bị coi là VCB', () => {
    const user = {
      roleCode: RoleCode.USER,
      allowedScreens: [
        Permission.SCREEN_INTAKE_ORDERS,
        Permission.INTAKE_CREATE,
      ],
    };
    expect(inferStaffJobPreset(user)).not.toBe('vcb');
  });

  it('thủ kho có quyền tạo đơn nhưng không bị nhận nhầm là VCB', () => {
    const { roleCode, allowedScreens } = roleAndScreensForPreset('warehouse');
    expect(inferStaffJobPreset({ roleCode, allowedScreens })).toBe('warehouse');
  });
});
