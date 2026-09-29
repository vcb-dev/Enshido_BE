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
}

export class IntakeProductSpecsDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  productWeightGram!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => IntakeOrderImageDto)
  images!: IntakeOrderImageDto[];
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
