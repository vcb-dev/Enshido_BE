import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { randomBytes } from 'crypto';
import {
  COOKIE_ACCESS,
  COOKIE_CSRF,
  COOKIE_REFRESH,
  COOKIE_SAMESITE,
} from './cookie.constants';
import { parseDurationMs } from '../util/duration';

@Injectable()
export class CookieAuthService {
  constructor(private readonly config: ConfigService) {}

  private baseOptions(): CookieOptions {
    const secure = this.config.get<string>('COOKIE_SECURE', 'false') === 'true';
    return {
      httpOnly: true,
      secure,
      sameSite: COOKIE_SAMESITE,
      path: '/',
    };
  }

  setAuthCookies(
    res: Response,
    tokens: { accessToken: string; refreshToken: string },
  ) {
    const accessMaxAge = parseDurationMs(
      this.config.get<string>('JWT_ACCESS_EXPIRES', '8h'),
    );
    const refreshMaxAge = parseDurationMs(
      this.config.get<string>('JWT_REFRESH_EXPIRES', '7d'),
    );
    const csrf = randomBytes(32).toString('hex');
    const base = this.baseOptions();

    res.cookie(COOKIE_ACCESS, tokens.accessToken, {
      ...base,
      maxAge: accessMaxAge,
    });

    res.cookie(COOKIE_REFRESH, tokens.refreshToken, {
      ...base,
      maxAge: refreshMaxAge,
      path: '/api/auth',
    });

    res.cookie(COOKIE_CSRF, csrf, {
      httpOnly: false,
      secure: base.secure,
      sameSite: COOKIE_SAMESITE,
      path: '/',
      maxAge: refreshMaxAge,
    });
  }

  clearAuthCookies(res: Response) {
    const secure = this.config.get<string>('COOKIE_SECURE', 'false') === 'true';
    res.clearCookie(COOKIE_ACCESS, {
      path: '/',
      sameSite: COOKIE_SAMESITE,
      secure,
    });
    res.clearCookie(COOKIE_REFRESH, {
      path: '/api/auth',
      sameSite: COOKIE_SAMESITE,
      secure,
    });
    res.clearCookie(COOKIE_CSRF, {
      path: '/',
      sameSite: COOKIE_SAMESITE,
      secure,
    });
  }
}
