import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { RoleCode } from '@prisma/client';
import { WAREHOUSE_SCREEN } from '../screens';
import { userHasPermission } from '../permissions';
import type { AuthUserPayload } from '../types';

@Injectable()
export class WarehouseScreenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user?: AuthUserPayload;
      params?: { code?: string };
    }>();
    const code = request.params?.code;
    if (!code) return true;

    const user = request.user;
    if (!user) throw new ForbiddenException('Không đủ quyền');
    if (user.roleCode === RoleCode.ADMIN) return true;

    const permission = WAREHOUSE_SCREEN[code];
    if (!permission) {
      throw new ForbiddenException('Không được xem kho này');
    }
    if (
      !userHasPermission(
        user.roleCode,
        user.extraRoles ?? [],
        permission,
        user.allowedScreens ?? [],
      )
    ) {
      throw new ForbiddenException('Không được xem kho này');
    }
    return true;
  }
}
