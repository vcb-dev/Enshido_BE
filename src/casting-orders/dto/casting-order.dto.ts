import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const DECIMAL = /^\d+(\.\d+)?$/;

export class ListCastingOrdersQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class CastingOrderLineDto {
  @IsUUID()
  materialId!: string;

  @Transform(({ value }) => (value === '' ? null : value))
  @Matches(DECIMAL, { message: 'Số gram không hợp lệ' })
  gramQty!: string;
}

export class CreateCastingOrderDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Nhập mã đúc' })
  @MaxLength(60)
  code!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  moldCount!: number;

  @IsArray()
  @ArrayMinSize(1, { message: 'Chọn ít nhất một mã NVL' })
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => CastingOrderLineDto)
  lines!: CastingOrderLineDto[];

  /** Bắt buộc khi sửa lệnh. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  editReason?: string;
}
