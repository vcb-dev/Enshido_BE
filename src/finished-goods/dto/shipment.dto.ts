import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const MONEY = /^\d+(\.\d{1,2})?$/;

export class ShipmentLineDto {
  @IsString()
  @MaxLength(20)
  orderCode!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;

  /** Đơn giá bán cho khách. */
  @Matches(MONEY, { message: 'Đơn giá bán không hợp lệ' })
  unitPrice!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpsertShipmentDto {
  @IsDateString()
  shippedAt!: string;

  @IsString()
  @MaxLength(200)
  customerName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Phiếu xuất phải có ít nhất một dòng hàng' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ShipmentLineDto)
  lines!: ShipmentLineDto[];

  /** Bắt buộc khi sửa phiếu xuất. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  editReason?: string;
}

export class ListShipmentsQuery {
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

export class StockQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/** Kho xác nhận nhận hàng vào tồn. Bỏ trống `qty` là nhận hết phần đang chờ. */
export class ReceiveReceiptDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty?: number;
}

export class UpsertReceiptDto {
  /** Bỏ trống khi nhập mới trên Tồn — hệ thống tự cấp mã. */
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsString()
  @MaxLength(20)
  orderCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  mainMaterial?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  platingColor?: string;

  @IsOptional()
  @Matches(MONEY, { message: 'Đơn giá tồn không hợp lệ' })
  stockUnitPrice?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  qty!: number;

  @IsDateString()
  receivedAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  sizeLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  qtyUnit?: string;

  /** NVL cấu thành — chỉ gửi khi tạo / sửa trên tab Tồn. */
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.filter((line: { materialId?: string }) =>
          Boolean(line?.materialId?.trim()),
        )
      : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BomLineDto)
  bomLines?: BomLineDto[];

  /** Bắt buộc khi sửa phiếu nhập / tồn thành phẩm. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  editReason?: string;
}

export class BomLineDto {
  @IsUUID()
  materialId!: string;
}
