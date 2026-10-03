import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

const DECIMAL = /^-?\d+(\.\d+)?$/;

export class CreateInboundDto {
  @IsDateString()
  receivedAt!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsUUID()
  materialId?: string | null;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsUUID()
  unitId?: string | null;

  @IsOptional()
  @IsString()
  unitName?: string;

  @Matches(DECIMAL, { message: 'Số lượng không hợp lệ' })
  qty!: string;

  /** Trọng lượng nhập (g) — kho NVL ghi nhận TL tồn cho mã không tính theo gram (đá tính viên…). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === '' || value == null ? null : value,
  )
  @Matches(DECIMAL, { message: 'Số gram không hợp lệ' })
  gramQty?: string | null;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Đơn giá tồn không hợp lệ' })
  stockUnitPrice?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Đơn giá không hợp lệ' })
  unitPrice?: string;

  @IsOptional()
  @Matches(DECIMAL, { message: 'Thành tiền không hợp lệ' })
  amount?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  supplierSku?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsUUID()
  supplierId?: string | null;

  @IsOptional()
  @IsString()
  supplierName?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  applyToStock?: boolean;

  @IsOptional()
  @IsString()
  locationCode?: string | null;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @IsUUID()
  otherClassId?: string | null;

  /** Bắt buộc khi sửa phiếu nhập. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  editReason?: string;
}
