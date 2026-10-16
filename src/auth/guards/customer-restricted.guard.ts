import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_CUSTOMER_KEY, IS_PUBLIC_KEY } from '../decorators';
import { isCustomerOnly } from '../permissions';
import type { AuthUserPayload } from '../types';

/**
 * Tài khoản khách (VCB) là người ngoài xưởng — chặn theo danh sách trắng: chỉ endpoint gắn
 * `@AllowCustomer()` (hoặc `@Public()`) mới qua. Thêm endpoint mới thì mặc định khách bị chặn.
 */
@Injectable()
export class CustomerRestrictedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthUserPayload }>().user;
    if (
      !user ||
      !isCustomerOnly(
        user.roleCode,
        user.extraRoles ?? [],
        user.allowedScreens ?? [],
      )
    ) {
      return true;
    }
    if (
      this.reflector.getAllAndOverride<boolean>(ALLOW_CUSTOMER_KEY, targets)
    ) {
      return true;
    }
    throw new ForbiddenException(
      'Tài khoản khách chỉ được tạo, xem và sửa đơn của mình',
    );
  }
}
