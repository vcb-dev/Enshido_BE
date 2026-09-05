import { RoleCode } from '@prisma/client';

export type AuthUserPayload = {
  id: string;
  username: string;
  email: string | null;
  fullName: string;
  roleCode: RoleCode;
  extraRoles: RoleCode[];
  department: string | null;
};

export type JwtPayload = {
  sub: string;
  username: string;
  fullName: string;
  roleCode: RoleCode;
  extraRoles: RoleCode[];
  department: string | null;
};
