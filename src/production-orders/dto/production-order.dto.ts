import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
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
import {
  ProductionImageKind,
  ProductionRequestType,
  ProductionSource,
  ProductionStage,
  ProductionStatus,
} from '@prisma/client';

const DECIMAL = /^\d+(\.\d+)?$/;
const MONEY = /^\d+(\.\d{1,2})?$/;

const emptyToNull = ({ value }: { value: unknown }) =>
  value === '' ? null : value;

export const ORDER_SORT_KEYS = [
  'code',
  'createdAt',
  'receivedDate',
  'status',
  'qty',
  'closedBy',
] as const;

export class ListProductionOrdersQuery {
  @IsOptional()
  @IsEnum(ProductionStatus)
  status?: ProductionStatus;

  @IsOptional()
  @IsEnum(ProductionRequestType)
  requestType?: ProductionRequestType;

  @IsOptional()
  @IsEnum(ProductionSource)
  source?: ProductionSource;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  receivedDate?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  dueDate?: string;

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

  @IsOptional()
  @IsIn(ORDER_SORT_KEYS)
  sort?: (typeof ORDER_SORT_KEYS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  dir?: 'asc' | 'desc';
}

export class OrderImageDto {
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

export class UpsertProductionOrderDto {
  /** Đơn NVL (làm từ đầu) hoặc Đơn BTP (lấy BTP có sẵn theo mã). */
  @IsEnum(ProductionSource)
  source!: ProductionSource;

  /** Dòng kho BTP — bắt buộc với Đơn BTP. */
  @IsOptional()
  @Transform(emptyToNull)
  @IsUUID()
  btpMaterialId?: string | null;

  /** Dòng kho NVL — bắt buộc với Đơn mới. */
  @IsOptional()
  @Transform(emptyToNull)
  @IsUUID()
  nvlMaterialId?: string | null;

  /** Mã thành phẩm trong kho thành phẩm — bắt buộc với Đơn mới. */
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  finishedProductCode?: string | null;

  @IsEnum(ProductionRequestType)
  requestType!: ProductionRequestType;

  @IsDateString()
  receivedDate!: string;

  @IsString()
  @MaxLength(120)
  closedBy!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  /** Đơn vị số lượng cần làm — chiếc hoặc đôi. */
  @IsOptional()
  @Transform(emptyToNull)
  @IsIn(['chiếc', 'đôi'])
  qtyUnit?: string | null;

  /** Số lượng thành phẩm cần lên đơn. */
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  finishedProductQty?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  model3dCode?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsUrl({ require_protocol: true })
  model3dUrl?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  leadTime!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  trackingCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  stoneColor?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  stoneTypes?: string[];

  @IsDateString()
  dueDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  size?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  sizeLabel?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stoneCount?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Trọng lượng đá không hợp lệ' })
  stoneWeight?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  laserEngraving?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  otherRequirements?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  mainMaterial?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  platingColor?: string;

  /** Danh mục BTP. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  btpCategory?: string;

  /** Phân loại sản phẩm (kho BTP). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  productKind?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsUUID()
  askedUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  debtStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  parentCode?: string;

  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => OrderImageDto)
  images!: OrderImageDto[];
}

export class ChangeStatusDto {
  @IsEnum(ProductionStatus)
  status!: ProductionStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Báo Đúc / Đúc về. */
export class CastingDto {
  @IsDateString()
  sentDate!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  returnedDate?: string | null;
}

/** Giao khâu cho thợ — người giao là tài khoản đăng nhập. */
export class HandoverStageDto {
  @Transform(emptyToNull)
  @IsUUID()
  craftsmanUserId!: string;

  @IsDateString()
  handedAt!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Trọng lượng giao (tổng) không hợp lệ' })
  handedTotalWeight?: string | null;

  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Trọng lượng giao (bạc) không hợp lệ' })
  handedSilverWeight!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class StartStageDto extends HandoverStageDto {
  @IsEnum(ProductionStage)
  stage!: ProductionStage;
}

/** KCS nhận lại hàng từ thợ và cân lại bạc — người KCS là tài khoản đăng nhập. */
export class ReturnStageDto {
  @IsDateString()
  returnedAt!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Trọng lượng nhận lại (tổng) không hợp lệ' })
  returnedTotalWeight?: string | null;

  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Trọng lượng nhận lại (bạc) không hợp lệ' })
  returnedSilverWeight!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'BTP thu hồi không hợp lệ' })
  btpRecoveredWeight?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Bạc thu hồi không hợp lệ' })
  silverRecoveredWeight?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(MONEY, { message: 'Tiền công không hợp lệ' })
  laborCost?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class OrderOptionsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

/** Chi phí khác của đơn (đúc thuê, 3D, thuê ngoài…). */
export class OrderCostDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @Matches(MONEY, { message: 'Số tiền không hợp lệ' })
  amount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
