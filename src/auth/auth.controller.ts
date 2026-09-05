import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  HttpCode,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CurrentUser, Public } from './decorators';
import { CookieAuthService } from '../cookie/cookie-auth.service';
import { COOKIE_REFRESH } from '../cookie/cookie.constants';
import type { AuthUserPayload } from './types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: CookieAuthService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto);
    this.cookies.setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return { user: result.user };
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[COOKIE_REFRESH] as string | undefined;
    const result = await this.authService.refresh(refreshToken ?? '');
    this.cookies.setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return { user: result.user };
  }

  @Public()
  @HttpCode(200)
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[COOKIE_REFRESH] as string | undefined;
    await this.authService.logout(refreshToken);
    this.cookies.clearAuthCookies(res);
    return { success: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUserPayload) {
    return this.authService.meFromPayload(user);
  }
}
