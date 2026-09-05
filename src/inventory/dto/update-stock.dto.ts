import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import { MaterialClass } from '@prisma/client';

const DECIMAL = /^-?\d+(\.\d+)?$/;

export class UpdateStockDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  locationCode?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUUID()
  unitId?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  shapeId?: string | null;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  colorId?: string | null;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  materialTypeId?: string | null;

  @IsOptional()
  @IsEnum(MaterialClass)
  classification?: MaterialClass;

  @IsOptional()
  @IsString()
  note?: string | null;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Tồn đầu kỳ SL không hợp lệ' })
  openingQty?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Đơn giá tồn không hợp lệ' })
  stockUnitPrice?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Tồn đầu kỳ TT không hợp lệ' })
  openingAmount?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Nhập SL không hợp lệ' })
  inQty?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Nhập TT không hợp lệ' })
  inAmount?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Xuất SL không hợp lệ' })
  outQty?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Xuất TT không hợp lệ' })
  outAmount?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Tồn kho SL không hợp lệ' })
  qty?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Tồn kho TT không hợp lệ' })
  amount?: string;
}

export class CreateStockDto {
  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  locationCode?: string;

  @IsString()
  name!: string;

  @IsUUID()
  unitId!: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  shapeId?: string | null;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  colorId?: string | null;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  materialTypeId?: string | null;

  @IsOptional()
  @IsString()
  note?: string | null;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Tồn đầu kỳ SL không hợp lệ' })
  openingQty?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Đơn giá tồn không hợp lệ' })
  stockUnitPrice?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Tồn đầu kỳ TT không hợp lệ' })
  openingAmount?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Nhập SL không hợp lệ' })
  inQty?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Nhập TT không hợp lệ' })
  inAmount?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Xuất SL không hợp lệ' })
  outQty?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Xuất TT không hợp lệ' })
  outAmount?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Tồn kho SL không hợp lệ' })
  qty?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Tồn kho TT không hợp lệ' })
  amount?: string;
}
