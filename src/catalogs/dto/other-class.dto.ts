import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { OtherClassKind } from '@prisma/client';

export class CreateOtherClassDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsEnum(OtherClassKind)
  kind?: OtherClassKind;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateOtherClassDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsString()
  editReason!: string;
}
