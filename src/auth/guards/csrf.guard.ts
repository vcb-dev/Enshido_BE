import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { COOKIE_CSRF, CSRF_HEADER } from '../../cookie/cookie.constants';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      return true;
    }

    const path = req.path || '';
    if (path.endsWith('/auth/login')) {
      return true;
    }

    const cookieToken = req.cookies?.[COOKIE_CSRF] as string | undefined;
    const headerToken = headerValue(req, CSRF_HEADER);

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      throw new ForbiddenException('CSRF token không hợp lệ');
    }

    return true;
  }
}
