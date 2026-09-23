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

/** Một mã NVL trên đơn — số lượng / xi / khắc nhập riêng từng dòng. */
export class ProductionNvlLineDto {
  @IsUUID()
  materialId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  platingColor?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

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

  /** Số lượng BTP xuất kho — Đơn BTP. */
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  btpQty?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  model3dCode?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsUrl({ require_protocol: true })
  model3dUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  leadTime?: string;

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

  /** Tổng TL bạc của đơn (g) — mốc chia gram cho phiếu con. */
  @IsOptional()
  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Tổng TL bạc không hợp lệ' })
  silverWeight?: string | null;

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

  /** NVL gắn thành phẩm — số lượng / xi / khắc từng mã khi lên đơn. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProductionNvlLineDto)
  nvlLines?: ProductionNvlLineDto[];
}

export class ChangeStatusDto {
  @IsEnum(ProductionStatus)
  status!: ProductionStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Chốt hàng đạt: đơn sang Hoàn thiện và vào kho thành phẩm. */
export class FinishOrderDto {
  @IsOptional()
  @Transform(emptyToNull)
  @IsDateString()
  finishedAt?: string | null;

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

  /** Tổng TL bạc (g) cân lúc Đúc về; bỏ trống thì giữ giá trị cũ. */
  @IsOptional()
  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Tổng TL bạc không hợp lệ' })
  silverWeight?: string | null;
}

/** Thông tin một lần giao khâu — người giao là tài khoản đăng nhập. */
export class HandoverInfoDto {
  @IsDateString()
  handedAt!: string;

  /** Số lượng giao cho thợ; bỏ trống thì hiểu là giao cả đơn. */
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  handedQty?: number | null;

  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Trọng lượng giao (bạc) không hợp lệ' })
  handedSilverWeight!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Giao khâu cho thợ (đơn chưa chia phiếu con). */
export class HandoverStageDto extends HandoverInfoDto {
  @Transform(emptyToNull)
  @IsUUID()
  craftsmanUserId!: string;
}

export class StartStageDto extends HandoverStageDto {
  @IsEnum(ProductionStage)
  stage!: ProductionStage;
}

/** KCS nhận lại hàng từ thợ và cân lại bạc — người KCS là tài khoản đăng nhập. */
export class ReturnStageDto {
  @IsDateString()
  returnedAt!: string;

  /** Số lượng nhận lại; bỏ trống thì hiểu là nhận lại đủ số đã giao. */
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  returnedQty?: number | null;

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

/** Sửa tiền công của một khâu ở phần chi phí (đã nhập lần đầu lúc KCS nhận lại). */
export class StageLaborDto {
  @IsOptional()
  @Transform(emptyToNull)
  @Matches(MONEY, { message: 'Tiền công không hợp lệ' })
  laborCost?: string | null;
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

/** Phiếu con: phần số lượng + gram bạc chia cho thợ. */
export class SubTicketDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Gram bạc của phiếu con không hợp lệ' })
  silverWeight!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Mở một khâu cho thợ tự nhận trên các phiếu con. Bỏ trống `nos` = mọi phiếu con đang rảnh. */
export class OpenSubTicketStageDto {
  @IsEnum(ProductionStage)
  stage!: ProductionStage;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  nos?: number[];
}

/** Chốt phiếu con ở nhánh Lỗi (bắt buộc lý do) hoặc Hoàn thiện. */
export class SubTicketOutcomeDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Cấp thêm SL / gram bạc cho phiếu con khi thợ làm giữa chừng phát hiện thiếu. */
export class SubTicketTopUpDto {
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  qty?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(DECIMAL, { message: 'Gram bạc cấp thêm không hợp lệ' })
  silverWeight?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
