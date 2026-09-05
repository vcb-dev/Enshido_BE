import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, type PermissionCode } from '../decorators';
import { userHasPermission } from '../permissions';
import type { AuthUserPayload } from '../types';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionCode[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthUserPayload }>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Không đủ quyền');
    }

    const ok = required.some((p) =>
      userHasPermission(user.roleCode, user.extraRoles ?? [], p),
    );
    if (!ok) {
      throw new ForbiddenException('Không đủ quyền cho thao tác này');
    }
    return true;
  }
}
