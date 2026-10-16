import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleCode } from '@prisma/client';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ProductionOrdersController } from '../production-orders/production-orders.controller';
import { IntakeOrdersController } from '../intake-orders/intake-orders.controller';
import { ALLOW_CUSTOMER_KEY } from './decorators';
import { CustomerRestrictedGuard } from './guards/customer-restricted.guard';
import { Permission } from './permissions';
import { roleAndScreensForPreset } from './staff-job-presets';
import type { AuthUserPayload } from './types';

const vcb: AuthUserPayload = {
  id: 'vcb',
  username: 'vcb',
  email: null,
  fullName: 'VCB',
  extraRoles: [],
  department: null,
  ...roleAndScreensForPreset('vcb'),
};

function contextFor(proto: object, method: string, actor: AuthUserPayload) {
  const handler = (proto as Record<string, () => unknown>)[method];
  const controller = (proto as { constructor: () => unknown }).constructor;
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: actor }) }),
  } as unknown as ExecutionContext;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

describe('tài khoản khách VCB — chỉ lên đơn, xem và sửa đơn', () => {
  const guard = new CustomerRestrictedGuard(new Reflector());

  it('toàn bộ hệ thống chỉ mở đúng các endpoint này cho khách', () => {
    const allowed: string[] = [];
    for (const file of controllerFiles(join(__dirname, '..'))) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exported = require(file) as Record<string, unknown>;
      for (const value of Object.values(exported)) {
        if (typeof value !== 'function') continue;
        const proto = value.prototype as Record<string, unknown>;
        for (const method of Object.getOwnPropertyNames(proto)) {
          if (
            Reflect.getMetadata(ALLOW_CUSTOMER_KEY, proto[method] as object)
          ) {
            allowed.push(`${value.name}.${method}`);
          }
        }
      }
    }
    expect(allowed.sort()).toEqual([
      'AuthController.me',
      'IntakeOrdersController.create',
      'IntakeOrdersController.list',
      'IntakeOrdersController.update',
      'UploadsController.signature',
    ]);
  });

  it.each([
    [IntakeOrdersController.prototype, 'list'],
    [IntakeOrdersController.prototype, 'create'],
    [IntakeOrdersController.prototype, 'update'],
  ])('khách gọi được %s', (proto, method) => {
    expect(guard.canActivate(contextFor(proto, method, vcb))).toBe(true);
  });

  it.each([
    [IntakeOrdersController.prototype, 'approve'],
    [IntakeOrdersController.prototype, 'remove'],
    [IntakeOrdersController.prototype, 'pipelineCounts'],
    [ProductionOrdersController.prototype, 'list'],
    [ProductionOrdersController.prototype, 'detail'],
    [ProductionOrdersController.prototype, 'costingOf'],
  ])('khách bị chặn ở endpoint khác', (proto, method) => {
    expect(() => guard.canActivate(contextFor(proto, method, vcb))).toThrow(
      ForbiddenException,
    );
  });

  it('nhân viên thường và admin không bị guard này chặn', () => {
    const staff = {
      ...vcb,
      allowedScreens: [
        Permission.SCREEN_INTAKE_ORDERS,
        Permission.INTAKE_CREATE,
      ],
    };
    const admin = { ...vcb, roleCode: RoleCode.ADMIN };
    for (const actor of [staff, admin]) {
      expect(
        guard.canActivate(
          contextFor(ProductionOrdersController.prototype, 'list', actor),
        ),
      ).toBe(true);
    }
  });
});
