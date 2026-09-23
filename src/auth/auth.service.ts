import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RoleCode } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { AuthUserPayload, JwtPayload } from './types';
import { permissionsForUser, roleLabelFor } from './permissions';
import { COOKIE_ACCESS } from '../cookie/cookie.constants';
import { parseDurationMs } from '../util/duration';
import { InflightMap, TtlCache } from '../util/ttl-cache';
import type { Request } from 'express';

export const BCRYPT_COST = 8;

const userSessionSelect = {
  id: true,
  username: true,
  email: true,
  fullName: true,
  roleCode: true,
  extraRoles: true,
  allowedScreens: true,
  department: true,
  isActive: true,
} as const;

const SESSION_TTL_MS = 5 * 60_000;

type DbUser = {
  id: string;
  username: string;
  email: string | null;
  fullName: string;
  roleCode: RoleCode;
  extraRoles: RoleCode[];
  allowedScreens?: string[];
  department: string | null;
  passwordHash?: string;
  isActive?: boolean;
};

@Injectable()
export class AuthService {
  private readonly sessionCache = new TtlCache();
  private readonly sessionInflight = new InflightMap();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const username = dto.username.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: {
        ...userSessionSelect,
        passwordHash: true,
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Tài khoản hoặc mật khẩu không đúng');
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Tài khoản hoặc mật khẩu không đúng');
    }

    this.maybeRehashPassword(user.id, dto.password, user.passwordHash);

    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token không hợp lệ');
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        revokedAt: true,
        expiresAt: true,
        user: {
          select: userSessionSelect,
        },
      },
    });

    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt < new Date() ||
      !stored.user.isActive
    ) {
      throw new UnauthorizedException('Refresh token không hợp lệ');
    }

    const [, tokens] = await Promise.all([
      this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      }),
      this.issueTokens(stored.user),
    ]);

    return tokens;
  }

  async logout(refreshToken?: string) {
    if (refreshToken) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { success: true };
  }

  meFromPayload(user: AuthUserPayload) {
    return this.toSessionUser(user);
  }

  async validateJwtPayload(payload: JwtPayload): Promise<AuthUserPayload> {
    if (!payload?.sub || !payload.username || !payload.roleCode) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }
    const cacheKey = `user:${payload.sub}`;
    const cached = this.sessionCache.get<AuthUserPayload>(cacheKey);
    if (cached) return cached;
    return this.sessionInflight.run(cacheKey, async () => {
      const again = this.sessionCache.get<AuthUserPayload>(cacheKey);
      if (again) return again;
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: userSessionSelect,
      });
      if (!user || !user.isActive) {
        throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
      }
      const publicUser = this.toPublicUser(user);
      this.sessionCache.set(cacheKey, publicUser, SESSION_TTL_MS);
      return publicUser;
    });
  }

  bustSession(userId: string) {
    this.sessionCache.delete(`user:${userId}`);
  }

  private async issueTokens(user: DbUser) {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      fullName: user.fullName,
      roleCode: user.roleCode,
      extraRoles: user.extraRoles ?? [],
      department: user.department,
    };

    const accessExpires = this.config.get<string>('JWT_ACCESS_EXPIRES', '8h');
    const accessMs = parseDurationMs(accessExpires);
    const refreshToken = randomBytes(48).toString('hex');
    const refreshDays = this.parseDays(
      this.config.get<string>('JWT_REFRESH_EXPIRES', '7d'),
    );

    const [accessToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        expiresIn: accessExpires as `${number}m` | `${number}d` | `${number}h`,
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hashToken(refreshToken),
          expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000),
        },
      }),
    ]);

    void this.prisma.refreshToken
      .deleteMany({
        where: {
          userId: user.id,
          OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
        },
      })
      .catch(() => undefined);

    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + accessMs).toISOString(),
      user: this.toSessionUser(user),
    };
  }

  expiresAtFromRequest(req: Request) {
    const token = req.cookies?.[COOKIE_ACCESS];
    if (typeof token === 'string' && token.length > 0) {
      const decoded = this.jwt.decode(token) as { exp?: number } | null;
      if (decoded?.exp) return new Date(decoded.exp * 1000).toISOString();
    }
    return new Date(
      Date.now() +
        parseDurationMs(this.config.get<string>('JWT_ACCESS_EXPIRES', '8h')),
    ).toISOString();
  }

  private maybeRehashPassword(
    userId: string,
    plain: string,
    currentHash: string,
  ) {
    try {
      const rounds = bcrypt.getRounds(currentHash);
      if (rounds <= BCRYPT_COST) return;
      void bcrypt
        .hash(plain, BCRYPT_COST)
        .then((passwordHash) =>
          this.prisma.user.update({
            where: { id: userId },
            data: { passwordHash },
          }),
        )
        .catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseDays(value: string) {
    const match = /^(\d+)d$/i.exec(value.trim());
    return match ? Number(match[1]) : 7;
  }

  private toPublicUser(user: DbUser): AuthUserPayload {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      roleCode: user.roleCode,
      extraRoles: user.extraRoles ?? [],
      allowedScreens: user.allowedScreens ?? [],
      department: user.department,
    };
  }

  private toSessionUser(user: DbUser) {
    const extraRoles = user.extraRoles ?? [];
    const allowedScreens = user.allowedScreens ?? [];
    return {
      ...this.toPublicUser(user),
      roleLabel: roleLabelFor(user.roleCode, extraRoles),
      permissions: permissionsForUser(
        user.roleCode,
        extraRoles,
        allowedScreens,
      ),
    };
  }
}
