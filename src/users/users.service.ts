import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { RoleCode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { AuthService, BCRYPT_COST } from '../auth/auth.service';
import { sanitizeScreens } from '../auth/permissions';
import { DEFAULT_STAFF_SCREENS } from '../auth/screens';
import { InventoryService } from '../inventory/inventory.service';

const userSelect = {
  id: true,
  username: true,
  email: true,
  fullName: true,
  roleCode: true,
  extraRoles: true,
  allowedScreens: true,
  department: true,
  isActive: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly auth: AuthService,
  ) {}

  list() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: userSelect,
    });
  }

  async create(dto: CreateUserDto) {
    const username = dto.username.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({ where: { username } });
    if (exists) {
      throw new ConflictException('Tài khoản đã tồn tại');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const allowedScreens =
      dto.roleCode === RoleCode.ADMIN
        ? []
        : sanitizeScreens(dto.allowedScreens ?? DEFAULT_STAFF_SCREENS);

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
        isActive: true,
      },
      select: userSelect,
    });
    this.inventory.bustLookups();
    return created;
  }

  async update(id: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Không tìm thấy user');

    const data: {
      fullName?: string;
      roleCode?: RoleCode;
      extraRoles?: RoleCode[];
      allowedScreens?: string[];
      department?: string | null;
      email?: string | null;
      isActive?: boolean;
      passwordHash?: string;
    } = {};

    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.roleCode !== undefined && user.roleCode !== RoleCode.ADMIN) {
      data.roleCode = dto.roleCode;
    }
    if (dto.extraRoles !== undefined) data.extraRoles = dto.extraRoles;
    if (dto.allowedScreens !== undefined && user.roleCode !== RoleCode.ADMIN) {
      data.allowedScreens = sanitizeScreens(dto.allowedScreens);
    }
    if (dto.department !== undefined) {
      data.department = dto.department.trim() || null;
    }
    if (dto.email !== undefined) data.email = dto.email.toLowerCase().trim() || null;
    if (dto.isActive !== undefined && user.roleCode !== RoleCode.ADMIN) {
      data.isActive = dto.isActive;
    }
    if (dto.password) data.passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      select: userSelect,
    });
    this.inventory.bustLookups();
    this.auth.bustSession(id);
    return updated;
  }
}
