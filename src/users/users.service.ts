import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { ProductionStage, RoleCode } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { recordEditLog } from '../edit-logs/edit-log';
import { actorName } from '../production-orders/order-detail';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { skillLevelFor } from './staff-positions';
import { AuthService, BCRYPT_COST } from '../auth/auth.service';
import {
  isProductionStageWorker,
  Permission,
  sanitizeScreens,
} from '../auth/permissions';
import { DEFAULT_STAFF_SCREENS } from '../auth/screens';
import { InventoryService } from '../inventory/inventory.service';
import { InflightMap, TtlCache } from '../util/ttl-cache';

const userSelect = {
  id: true,
  username: true,
  email: true,
  fullName: true,
  roleCode: true,
  extraRoles: true,
  allowedScreens: true,
  department: true,
  position: true,
  skillLevel: true,
  workerStages: true,
  isActive: true,
  createdAt: true,
} as const;

const USERS_TTL_MS = 60_000;

@Injectable()
export class UsersService {
  private readonly cache = new TtlCache();
  private readonly inflight = new InflightMap();

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly auth: AuthService,
  ) {}

  list() {
    const hit =
      this.cache.get<Awaited<ReturnType<UsersService['loadUsers']>>>('users');
    if (hit) return Promise.resolve(hit);
    return this.inflight.run('users', async () => {
      const again =
        this.cache.get<Awaited<ReturnType<UsersService['loadUsers']>>>('users');
      if (again) return again;
      const value = await this.loadUsers();
      this.cache.set('users', value, USERS_TTL_MS);
      return value;
    });
  }

  private loadUsers() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: userSelect,
    });
  }

  private bustUsers() {
    this.cache.delete('users');
  }

  async create(dto: CreateUserDto) {
    const username = dto.username.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({ where: { username } });
    if (exists) {
      throw new ConflictException('Tài khoản đã tồn tại');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    // Admin xem hết nên không có màn mặc định; vẫn lưu quyền việc nếu được gán thêm vai trò
    // (Thợ đúc, Thủ kho, …) để màn Nhân sự hiện đủ vai trò. Thợ đã có quyền kèm role, không cần
    // preset văn phòng.
    const allowedScreens =
      dto.roleCode === RoleCode.ADMIN || dto.roleCode === RoleCode.WORKER
        ? sanitizeScreens(dto.allowedScreens ?? [])
        : sanitizeScreens(dto.allowedScreens ?? DEFAULT_STAFF_SCREENS);

    const workerStages = workerStagesFor(
      dto.roleCode,
      dto.extraRoles ?? [],
      dto.workerStages ?? [],
      allowedScreens,
    );

    const created = await this.prisma.user.create({
      data: {
        username,
        email: dto.email?.toLowerCase().trim() || null,
        passwordHash,
        fullName: dto.fullName.trim(),
        roleCode: dto.roleCode,
        extraRoles: dto.extraRoles ?? [],
        allowedScreens,
        department: dto.department?.trim() || null,
        position: dto.position || null,
        skillLevel: skillLevelFor(dto.position, dto.skillLevel),
        workerStages,
        isActive: true,
      },
      select: userSelect,
    });
    this.inventory.bustLookups();
    this.bustUsers();
    return created;
  }

  async update(id: string, dto: UpdateUserDto, actor?: AuthUserPayload) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Không tìm thấy user');

    const data: {
      fullName?: string;
      roleCode?: RoleCode;
      extraRoles?: RoleCode[];
      allowedScreens?: string[];
      department?: string | null;
      position?: string | null;
      skillLevel?: number | null;
      email?: string | null;
      isActive?: boolean;
      passwordHash?: string;
      workerStages?: ProductionStage[];
    } = {};

    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.roleCode !== undefined && user.roleCode !== RoleCode.ADMIN) {
      data.roleCode = dto.roleCode;
    }
    if (dto.extraRoles !== undefined) data.extraRoles = dto.extraRoles;
    // Admin cũng lưu được: quyền việc đi kèm vai trò (Thợ đúc, Thủ kho, …) chỉ để nhận diện vai trò,
    // admin vẫn có mọi quyền.
    if (dto.allowedScreens !== undefined) {
      data.allowedScreens = sanitizeScreens(dto.allowedScreens);
    }
    if (dto.department !== undefined) {
      data.department = dto.department.trim() || null;
    }
    // Vị trí / bậc tay nghề: bậc chỉ giữ khi vị trí (mới hoặc đang có) là thợ.
    if (dto.position !== undefined || dto.skillLevel !== undefined) {
      const position =
        dto.position !== undefined ? dto.position || null : user.position;
      data.position = position;
      data.skillLevel = skillLevelFor(
        position,
        dto.skillLevel !== undefined ? dto.skillLevel : user.skillLevel,
      );
    }
    if (dto.email !== undefined)
      data.email = dto.email.toLowerCase().trim() || null;
    if (dto.isActive !== undefined && user.roleCode !== RoleCode.ADMIN) {
      data.isActive = dto.isActive;
    }
    if (dto.password)
      data.passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    if (
      dto.workerStages !== undefined ||
      dto.roleCode !== undefined ||
      dto.extraRoles !== undefined
    ) {
      data.workerStages = workerStagesFor(
        data.roleCode ?? user.roleCode,
        data.extraRoles ?? user.extraRoles,
        dto.workerStages ?? user.workerStages,
        data.allowedScreens ?? user.allowedScreens,
      );
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      select: userSelect,
    });
    if (dto.editReason && actor) {
      await recordEditLog(this.prisma, {
        entityType: 'user',
        entityId: updated.id,
        reason: dto.editReason,
        changedBy: actorName(actor),
      });
    }
    this.inventory.bustLookups();
    this.bustUsers();
    this.auth.bustSession(id);
    return updated;
  }
}

const STAGE_ORDER = Object.values(ProductionStage);

/**
 * Khâu lưu kèm tài khoản.
 * - Admin kiêm Thợ khâu nào thì lưu khâu đó (không gán thì thôi).
 * - Tài khoản role Thợ phải có ít nhất một khâu (trừ thợ 3D / sáp / đúc, khâu tuỳ chọn).
 * - Nhân viên văn phòng (Thủ kho, QC, Kế toán, …) kiêm Thợ khâu: có quyền Thợ sản xuất thì lưu
 *   khâu; không có thì bỏ khâu.
 */
export function workerStagesFor(
  roleCode: RoleCode,
  extraRoles: RoleCode[],
  stages: ProductionStage[],
  allowedScreens: readonly string[] = [],
) {
  const unique = STAGE_ORDER.filter((stage) => stages.includes(stage));
  const roles = [roleCode, ...extraRoles];
  if (roles.includes(RoleCode.ADMIN)) return unique;
  if (!roles.includes(RoleCode.WORKER)) {
    return allowedScreens.includes(Permission.PRODUCTION_WORKER) ? unique : [];
  }
  if (isProductionStageWorker(roleCode, extraRoles, allowedScreens)) {
    return unique;
  }
  // Thợ sau đúc chọn vai trò theo khâu (Thợ nguội / đá / khắc / bóng / xi) — không còn thợ
  // mặc định nhận mọi khâu.
  if (!unique.length) {
    throw new BadRequestException(
      'Thợ phải có khâu làm — chọn vai trò thợ theo khâu (Thợ nguội, Thợ đá, …)',
    );
  }
  return unique;
}
