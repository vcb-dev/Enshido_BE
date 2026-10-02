import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsUUID,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CastingSlipImageDto {
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

/**
 * Bước 7: thủ kho lọc các đơn đã có sáp (E), gom vào một lần đúc, cấp bạc + hội theo định mức
 * và chụp ảnh phiếu + vật tư.
 */
export class CreateCastingSlipDto {
  @IsDateString()
  slipDate!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Chọn ít nhất một đơn đi đúc' })
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  intakeOrderIds!: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  issueS999Gram?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  issueMasterAlloyGram?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  issueS925Gram?: number;

  /** Thợ đúc được giao phiếu (quyền production.cast). */
  @IsUUID('4')
  assignedUserId!: string;
}

/** Bước 7 (sau khi in phiếu và cấp vật tư): chụp ảnh phiếu đúc + vật tư kèm theo rồi Lưu. */
export class IssueCastingSlipDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Chụp ảnh phiếu đúc và vật tư kèm theo' })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CastingSlipImageDto)
  images!: CastingSlipImageDto[];
}

export class CastingLossQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class CastingSlipCandidatesQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/** Bước 9: thợ đúc nhập kết quả sau đúc — ảnh cân cây thông + bạc, thạch cao đã dùng. */
export class CastingSlipResultDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  castTreeWeightGram!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  silverUsedGram!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  plasterUsedGram!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CastingSlipImageDto)
  images!: CastingSlipImageDto[];
}

export class ListCastingSlipsQuery {
  @IsOptional()
  @IsIn([
    'PENDING_ISSUE',
    'WAIT_CASTING',
    'CASTING',
    'PENDING_CONFIRMATION',
    'DONE',
    'CAST_FAILED',
  ])
  status?:
    | 'PENDING_ISSUE'
    | 'WAIT_CASTING'
    | 'CASTING'
    | 'PENDING_CONFIRMATION'
    | 'DONE'
    | 'CAST_FAILED';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsDateString()
  slipDate?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  intakeCode?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  batchOrderCodes?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(50)
  waxWeight?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(50)
  issueTotal?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
