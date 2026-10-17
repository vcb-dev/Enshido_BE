import { BadRequestException } from '@nestjs/common';
import { ProductionStage, RoleCode } from '@prisma/client';
import { Permission } from '../auth/permissions';
import { workerStagesFor } from './users.service';

const { FILING, PLATING, STONE_SETTING } = ProductionStage;

describe('workerStagesFor — khâu lưu kèm tài khoản', () => {
  it('Admin kiêm Thợ khâu nào thì lưu khâu đó, theo thứ tự luồng; không gán thì rỗng', () => {
    expect(workerStagesFor(RoleCode.ADMIN, [], [PLATING, FILING])).toEqual([
      FILING,
      PLATING,
    ]);
    expect(workerStagesFor(RoleCode.ADMIN, [], [])).toEqual([]);
  });

  it('nhân viên văn phòng kiêm Thợ khâu: có quyền Thợ sản xuất thì lưu khâu', () => {
    expect(
      workerStagesFor(
        RoleCode.USER,
        [],
        [STONE_SETTING],
        [Permission.PRODUCTION_QC, Permission.PRODUCTION_WORKER],
      ),
    ).toEqual([STONE_SETTING]);
  });

  it('nhân viên văn phòng không có quyền Thợ sản xuất thì bỏ khâu', () => {
    expect(
      workerStagesFor(RoleCode.USER, [], [FILING], [Permission.PRODUCTION_QC]),
    ).toEqual([]);
  });

  it('tài khoản Thợ: bắt buộc có khâu, trừ thợ 3D / sáp / đúc', () => {
    expect(workerStagesFor(RoleCode.WORKER, [], [FILING])).toEqual([FILING]);
    expect(() => workerStagesFor(RoleCode.WORKER, [], [])).toThrow(
      BadRequestException,
    );
    expect(
      workerStagesFor(RoleCode.WORKER, [], [], [Permission.PRODUCTION_CAST]),
    ).toEqual([]);
    expect(
      workerStagesFor(
        RoleCode.WORKER,
        [],
        [FILING],
        [Permission.PRODUCTION_MODEL3D],
      ),
    ).toEqual([FILING]);
  });
});
