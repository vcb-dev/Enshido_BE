import type { AuthUserPayload } from '../auth/types';
import { Permission, userCan } from '../auth/permissions';

/** Thủ kho: quyền `warehouse.keeper` (admin luôn có). */
export function canConfirmIntakeWarehouse(user: AuthUserPayload): boolean {
  return userCan(user, Permission.WAREHOUSE_KEEPER);
}
