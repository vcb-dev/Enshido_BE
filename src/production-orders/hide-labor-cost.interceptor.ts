import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { Permission, userCan } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';

/** Tiền công là chi phí — chỉ thủ kho và kế toán (cùng admin) được xem. */
export function canSeeCosts(user: AuthUserPayload | undefined): boolean {
  return (
    user != null &&
    userCan(user, Permission.WAREHOUSE_KEEPER, Permission.ACCOUNTING_APPROVE)
  );
}

/**
 * Bản sao không có tiền công: mọi khoá `laborCost` (kể cả trong nhật ký sửa) thành null. Chỉ
 * chép object thường và mảng — không sửa tại chỗ vì chi tiết đơn nằm trong cache dùng chung.
 */
export function withoutLaborCost<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withoutLaborCost(item)) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'laborCost' ? null : withoutLaborCost(item),
    ]),
  ) as T;
}

@Injectable()
export class HideLaborCostInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthUserPayload }>().user;
    if (canSeeCosts(user)) return next.handle();
    return next.handle().pipe(map((body: unknown) => withoutLaborCost(body)));
  }
}
