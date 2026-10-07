import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
  estimateS999Gram?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimateMasterAlloyGram?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimateS925Gram?: number;

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

/** Bước 7 (sau khi in phiếu): nhập thực xuất (không nhập thì lấy ước tính) + ảnh rồi Lưu. */
export class IssueCastingSlipDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Chụp ảnh phiếu đúc và vật tư kèm theo' })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CastingSlipImageDto)
  images!: CastingSlipImageDto[];

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

export class ConfirmCastingBlankDto {
  @IsUUID()
  intakeOrderId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  weightGram!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CastingSlipImageDto)
  images!: CastingSlipImageDto[];
}

/** Xác nhận đúc và chia phôi thẳng vào lệnh sản xuất, không lập phiếu cắt. */
export class ConfirmCastingSlipDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ConfirmCastingBlankDto)
  blanks!: ConfirmCastingBlankDto[];

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  restWeightGram!: number;

  @IsOptional()
  @IsUUID()
  restMaterialId?: string | null;

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CastingSlipImageDto)
  restImages!: CastingSlipImageDto[];
}

/** Cắt nhiều phiếu cùng lần, giữ số cân riêng theo từng cây thông. */
export class CutCastingSlipItemDto extends ConfirmCastingSlipDto {
  @IsUUID()
  slipId!: string;
}

export class CutCastingSlipsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => CutCastingSlipItemDto)
  items!: CutCastingSlipItemDto[];
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
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  intakeCode?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  batchOrderCodes?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  waxWeight?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  issueTotal?: string;

  /** Hàng đợi cắt cây: phiếu Đúc xong, đơn còn CAST_DONE, chưa chia phôi. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  awaitingCut?: boolean;

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
