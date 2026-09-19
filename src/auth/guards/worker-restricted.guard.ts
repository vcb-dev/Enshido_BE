import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BLOCK_WORKER_KEY } from '../decorators';
import { isWorkerOnly } from '../permissions';
import type { AuthUserPayload } from '../types';

/**
 * Chặn tài khoản chỉ làm thợ khỏi các màn quản lý đơn sản xuất. Hệ quyền màn hình chỉ biết
 * "cho thêm" nên việc cấm phải đánh dấu tường minh bằng `@BlockWorker()` trên từng endpoint.
 */
@Injectable()
export class WorkerRestrictedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const blocked = this.reflector.getAllAndOverride<boolean>(
      BLOCK_WORKER_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!blocked) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthUserPayload }>();
    const user = request.user;
    if (user && isWorkerOnly(user.roleCode, user.extraRoles ?? [])) {
      throw new ForbiddenException(
        'Tài khoản Thợ chỉ làm việc trên phiếu con của mình',
      );
    }
    return true;
  }
}
