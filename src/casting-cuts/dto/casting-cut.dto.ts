import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const DECIMAL = /^\d+(\.\d+)?$/;

const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class ListCastingCutsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

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

export class CutImageDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string;

  @IsString()
  @MaxLength(300)
  publicId!: string;

  @IsOptional()
  @IsInt()
  width?: number | null;

  @IsOptional()
  @IsInt()
  height?: number | null;
}

/** Phôi của một đơn: số lượng, TL cân và ảnh cân. */
export class CastingCutLineDto {
  /** Phiếu sản xuất có sẵn (đơn cũ tạo tay). Đúng một trong `orderId` / `intakeOrderId`. */
  @IsOptional()
  @IsUUID()
  orderId?: string;

  /** Đơn tạo đã Đúc xong (H) — cắt xong hệ thống tự sinh phiếu sản xuất cho đơn. */
  @IsOptional()
  @IsUUID()
  intakeOrderId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @Matches(DECIMAL, { message: 'Trọng lượng phôi không hợp lệ' })
  weight!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Chụp ảnh cân phôi của từng đơn' })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CutImageDto)
  images!: CutImageDto[];
}

export class CreateCastingCutDto {
  @IsOptional()
  @Transform(trimToNull)
  @IsUUID()
  castingOrderId?: string | null;

  /** Phiếu đúc đã Đúc xong của cây thông đem cắt — các đơn tạo trên dòng phải thuộc phiếu này. */
  @IsOptional()
  @Transform(trimToNull)
  @IsUUID()
  castingSlipId?: string | null;

  @IsDateString()
  cutAt!: string;

  @Matches(DECIMAL, { message: 'Trọng lượng cây thông không hợp lệ' })
  treeWeight!: string;

  @Matches(DECIMAL, { message: 'Trọng lượng phần còn lại không hợp lệ' })
  restWeight!: string;

  /** Mã NVL nhận phần còn lại; bỏ trống thì dùng mã bạc thu hồi mặc định. */
  @IsOptional()
  @Transform(trimToNull)
  @IsUUID()
  restMaterialId?: string | null;

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CutImageDto)
  restImages!: CutImageDto[];

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @IsArray()
  @ArrayMinSize(1, { message: 'Thêm ít nhất một đơn nhận phôi' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CastingCutLineDto)
  lines!: CastingCutLineDto[];
}

export class DeleteCastingCutDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500)
  @Matches(/\S/, { message: 'Nhập lý do xoá phiếu cắt' })
  reason!: string;
}
