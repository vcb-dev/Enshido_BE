import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { randomBytes } from 'crypto';
import {
  COOKIE_ACCESS,
  COOKIE_CSRF,
  COOKIE_REFRESH,
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
      sameSite: 'lax',
      path: '/',
    };
  }

  setAuthCookies(
    res: Response,
    tokens: { accessToken: string; refreshToken: string },
  ) {
    const accessMaxAge = parseDurationMs(
      this.config.get<string>('JWT_ACCESS_EXPIRES', '15m'),
    );
    const refreshMaxAge = parseDurationMs(
      this.config.get<string>('JWT_REFRESH_EXPIRES', '7d'),
    );
    const csrf = randomBytes(32).toString('hex');

    res.cookie(COOKIE_ACCESS, tokens.accessToken, {
      ...this.baseOptions(),
      maxAge: accessMaxAge,
    });

    res.cookie(COOKIE_REFRESH, tokens.refreshToken, {
      ...this.baseOptions(),
      maxAge: refreshMaxAge,
      path: '/api/auth',
    });

    res.cookie(COOKIE_CSRF, csrf, {
      httpOnly: false,
      secure: this.config.get<string>('COOKIE_SECURE', 'false') === 'true',
      sameSite: 'lax',
      path: '/',
      maxAge: refreshMaxAge,
    });
  }

  clearAuthCookies(res: Response) {
    const secure = this.config.get<string>('COOKIE_SECURE', 'false') === 'true';
    res.clearCookie(COOKIE_ACCESS, { path: '/', sameSite: 'lax', secure });
    res.clearCookie(COOKIE_REFRESH, {
      path: '/api/auth',
      sameSite: 'lax',
      secure,
    });
    res.clearCookie(COOKIE_CSRF, { path: '/', sameSite: 'lax', secure });
  }
}
