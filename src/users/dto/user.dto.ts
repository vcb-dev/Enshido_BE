import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  IsArray,
} from 'class-validator';
import { RoleCode } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9._-]{3,32}$/, {
    message: 'Tài khoản chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang (3–32 ký tự)',
  })
  username!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  @MinLength(2)
  fullName!: string;

  @IsEnum(RoleCode)
  roleCode!: RoleCode;

  @IsOptional()
  @IsArray()
  @IsEnum(RoleCode, { each: true })
  extraRoles?: RoleCode[];

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  department?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  @IsOptional()
  @IsEnum(RoleCode)
  roleCode?: RoleCode;

  @IsOptional()
  @IsArray()
  @IsEnum(RoleCode, { each: true })
  extraRoles?: RoleCode[];

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;
}
