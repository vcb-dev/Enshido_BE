import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  MaxLength,
  Min,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import {
  IntakeOrderStatus,
  ProductionImageKind,
  ProductionRequestType,
} from '@prisma/client';

const emptyToNull = ({ value }: { value: unknown }) =>
  value === '' ? null : value;

export class IntakeOrderImageDto {
  @IsEnum(ProductionImageKind)
  kind!: ProductionImageKind;

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

export class UpsertIntakeOrderDto {
  @IsEnum(ProductionRequestType)
  requestType!: ProductionRequestType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  productName!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(120)
  trackingCode?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  placedBy!: string;

  @IsString()
  @MaxLength(8000)
  description!: string;

  @IsDateString()
  createdDate!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  dueDate?: string | null;

  @IsOptional()
  @IsEnum(IntakeOrderStatus)
  status?: IntakeOrderStatus;

  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => IntakeOrderImageDto)
  images!: IntakeOrderImageDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  editReason?: string;
}

export class ApproveIntakeOrderDto {
  /** true = đã có khuôn; false (mặc định) = cần vẽ 3D in resin. */
  @IsBoolean()
  hasMold!: boolean;
}

export class RejectIntakeOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class IntakeModel3dDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  model3dUrl!: string;

  /** Đá theo file 3D: số viên cả đơn; 0 = đơn không có đá (bỏ qua khâu Vào đá). */
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stoneCount3d?: number | null;

  /** Đá theo file 3D: tổng TL (g) cả đơn — mốc tính hao hụt khâu Vào đá. */
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stoneWeight3dGram?: number | null;
}

export class IntakeProductSpecsDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  productWeightGram!: number;

  /** Đá theo file 3D: số viên cả đơn; 0 = đơn không có đá (bỏ qua khâu Vào đá). */
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stoneCount3d?: number | null;

  /** Đá theo file 3D: tổng TL (g) cả đơn — mốc tính hao hụt khâu Vào đá. */
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stoneWeight3dGram?: number | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => IntakeOrderImageDto)
  images!: IntakeOrderImageDto[];
}

export class IntakeWaxPrintItemDto {
  @IsUUID()
  id!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  productWeightGram!: number;
}

/** Bước 4: một lượt in sáp nhiều đơn — ảnh cả khay + cân nặng từng đơn. */
export class IntakeWaxPrintBatchDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Chọn ít nhất một đơn đã in' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => IntakeWaxPrintItemDto)
  items!: IntakeWaxPrintItemDto[];

  @IsArray()
  @ArrayMinSize(1, { message: 'Chụp ảnh cả khay sáp in' })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => IntakeOrderImageDto)
  images!: IntakeOrderImageDto[];
}

/** Một đơn trong lượt in sáp: TL mẫu sáp của riêng đơn đó (tách từ khay). */
export class WaxPrintItemDto {
  @IsUUID()
  id!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  productWeightGram!: number;
}

/** Bước 4: thợ 3D in nhiều đơn một lần, chụp ảnh cả khay, rồi tách cân nặng từng đơn. */
export class WaxPrintBatchDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Chọn ít nhất một đơn đã in sáp' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => WaxPrintItemDto)
  items!: WaxPrintItemDto[];

  @IsArray()
  @ArrayMinSize(1, { message: 'Chụp ảnh khay sáp' })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => IntakeOrderImageDto)
  images!: IntakeOrderImageDto[];
}

/** Bước 5–6: thủ kho xác nhận sáp (số cân kiểm tùy chọn — thường dùng TL thợ báo). */
export class ConfirmWarehouseDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  checkedWeightGram?: number;
}

export class IntakeCastingTreeSpecsDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  castingTreeWeightGram!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => IntakeOrderImageDto)
  images!: IntakeOrderImageDto[];
}

/** Lọc chung cho tab Tất cả (gộp nhiều trạng thái intake). */
export class IntakePipelineListsQuery {
  @IsOptional()
  @IsEnum(ProductionRequestType)
  requestType?: ProductionRequestType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class ListIntakeOrdersQuery {
  @IsOptional()
  @IsEnum(IntakeOrderStatus)
  status?: IntakeOrderStatus;

  @IsOptional()
  @IsEnum(ProductionRequestType)
  requestType?: ProductionRequestType;

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
  pageSize?: number;
}
