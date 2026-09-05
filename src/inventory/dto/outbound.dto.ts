import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

const DECIMAL = /^-?\d+(\.\d+)?$/;

export class CreateOutboundDto {
  @IsDateString()
  issuedAt!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  materialId?: string | null;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  unitId?: string | null;

  @IsOptional()
  @IsString()
  unitName?: string;

  @Matches(DECIMAL, { message: 'Số lượng không hợp lệ' })
  qty!: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Đơn giá tồn không hợp lệ' })
  stockUnitPrice?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Đơn giá xuất không hợp lệ' })
  inboundUnitPrice?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Thành tiền không hợp lệ' })
  amount?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  issuedBy?: string;

  @IsOptional()
  @IsString()
  receivedBy?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  applyToStock?: boolean;
}
