import { ProductionStage, RoleCode } from '@prisma/client';
import { Permission } from './permissions';
import {
  inferStaffJobPreset,
  inferStaffJobPresets,
  isCastWorkerAssignee,
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

describe('nhiều vai trò trên một tài khoản', () => {
  const job = (...presets: Parameters<typeof roleAndScreensForPreset>[0][]) =>
    presets.flatMap((preset) => roleAndScreensForPreset(preset).allowedScreens);

  it('QC kiêm Thợ nguội: đủ cả hai vai trò, nhãn ghép', () => {
    const user = {
      roleCode: RoleCode.USER,
      allowedScreens: job('kcs', 'worker_filing'),
      workerStages: [ProductionStage.FILING],
    };
    expect(inferStaffJobPresets(user)).toEqual(['worker_filing', 'kcs']);
    expect(staffJobLabelFor(user)).toBe('Thợ nguội + QC');
    expect(inferStaffJobPreset(user)).toBe('worker_filing');
  });

  it('Thủ kho + QC + Kế toán gộp, không còn "Kế toán chỉ khi không phải thủ kho"', () => {
    const user = {
      roleCode: RoleCode.USER,
      allowedScreens: job('warehouse', 'kcs', 'accountant'),
    };
    expect(inferStaffJobPresets(user)).toEqual([
      'warehouse',
      'kcs',
      'accountant',
    ]);
    expect(staffJobLabelFor(user)).toBe('Thủ kho + QC + Kế toán');
  });

  it('Thợ 3D + Thợ sáp + Thợ đúc + nhiều khâu, theo thứ tự cố định', () => {
    const user = {
      roleCode: RoleCode.WORKER,
      allowedScreens: job(
        'worker_casting',
        'worker_wax',
        'worker_3d',
        'worker_plate',
      ),
      workerStages: [ProductionStage.PLATING, ProductionStage.FILING],
    };
    expect(staffJobLabelFor(user)).toBe(
      'Thợ 3D + Thợ sáp + Thợ đúc + Thợ nguội + Thợ xi',
    );
  });

  it('Admin kiêm vai trò khác: Admin đứng đầu, vai trò đọc từ quyền đã lưu', () => {
    const user = {
      roleCode: RoleCode.ADMIN,
      allowedScreens: [
        Permission.PRODUCTION_WORKER,
        Permission.PRODUCTION_CAST,
      ],
      workerStages: [ProductionStage.PLATING],
    };
    expect(inferStaffJobPresets(user)).toEqual([
      'admin',
      'worker_casting',
      'worker_plate',
    ]);
    expect(staffJobLabelFor(user)).toBe('Admin + Thợ đúc + Thợ xi');
    // Admin không kiêm gì vẫn chỉ là Admin.
    expect(
      staffJobLabelFor({ roleCode: RoleCode.ADMIN, allowedScreens: [] }),
    ).toBe('Admin');
  });

  it('VCB luôn đứng một mình, kể cả khi còn quyền khác', () => {
    const user = {
      roleCode: RoleCode.USER,
      allowedScreens: [...job('vcb'), Permission.WAREHOUSE_KEEPER],
    };
    expect(inferStaffJobPresets(user)).toEqual(['vcb']);
  });

  it('chỉ nhân sự có vai trò Thợ đúc (kể cả kiêm vai trò khác) được giao phiếu đúc', () => {
    expect(
      isCastWorkerAssignee({
        roleCode: RoleCode.WORKER,
        allowedScreens: job('worker_casting'),
      }),
    ).toBe(true);
    // Thủ kho kiêm Thợ đúc.
    expect(
      isCastWorkerAssignee({
        roleCode: RoleCode.USER,
        allowedScreens: job('warehouse', 'worker_casting'),
      }),
    ).toBe(true);
    // Admin được gán vai trò Thợ đúc.
    expect(
      isCastWorkerAssignee({
        roleCode: RoleCode.ADMIN,
        allowedScreens: [Permission.PRODUCTION_CAST],
      }),
    ).toBe(true);
    // Admin không gán, thủ kho thuần: không.
    expect(
      isCastWorkerAssignee({ roleCode: RoleCode.ADMIN, allowedScreens: [] }),
    ).toBe(false);
    expect(
      isCastWorkerAssignee({
        roleCode: RoleCode.USER,
        allowedScreens: job('warehouse'),
      }),
    ).toBe(false);
  });
});
