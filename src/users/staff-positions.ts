/**
 * Vị trí công việc trên màn Nhân sự — chỉ để hiển thị / thống kê. Quyền vẫn theo vai trò
 * (`staff-job-presets.ts`), đổi vị trí không đổi quyền.
 */
export const STAFF_POSITIONS = [
  'accountant',
  'warehouse_keeper',
  'manager',
  'qc',
  'kcs',
  'worker_3d',
  'worker_wax',
  'worker_casting',
  'worker_filing',
  'worker_stone',
  'worker_engrave',
  'worker_polish',
  'worker_plate',
] as const;

export type StaffPosition = (typeof STAFF_POSITIONS)[number];

export const SKILL_LEVEL_MIN = 1;
export const SKILL_LEVEL_MAX = 5;

/** Vị trí thợ mới có bậc tay nghề. */
export function isWorkerPosition(position: string | null | undefined) {
  return position != null && position.startsWith('worker_');
}

/** Bậc tay nghề chỉ giữ khi vị trí là thợ; còn lại về null. */
export function skillLevelFor(
  position: string | null | undefined,
  skillLevel: number | null | undefined,
) {
  return isWorkerPosition(position) ? (skillLevel ?? null) : null;
}
