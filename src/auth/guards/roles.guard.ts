import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleCode } from '@prisma/client';
import { ROLES_KEY } from '../decorators';
import { userHasRole } from '../permissions';
import type { AuthUserPayload } from '../types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<RoleCode[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthUserPayload }>();
    const user = request.user;
    if (
      !user ||
      !roles.some((r) => userHasRole(user.roleCode, user.extraRoles ?? [], r))
    ) {
      throw new ForbiddenException('Không đủ quyền');
    }
    return true;
  }
}
