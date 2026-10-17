import { ProductionStage, RoleCode } from '@prisma/client';

export type AuthUserPayload = {
  id: string;
  username: string;
  email: string | null;
  fullName: string;
  roleCode: RoleCode;
  extraRoles: RoleCode[];
  allowedScreens: string[];
  department: string | null;
  /** Khâu thợ được giao — nhãn vai trò ở góc màn hình ghép "Thợ nguội + QC" cần đến. */
  workerStages?: ProductionStage[];
};

export type JwtPayload = {
  sub: string;
  username: string;
  fullName: string;
  roleCode: RoleCode;
  extraRoles: RoleCode[];
  department: string | null;
};
