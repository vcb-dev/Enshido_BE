import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
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

/** Một cối = một phiếu đúc (gram giao + ảnh). */
export class CreateIntakeCastingSlipFlaskDto {
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

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CastingSlipImageDto)
  images!: CastingSlipImageDto[];
}

export class CreateIntakeCastingSlipDto {
  @IsDateString()
  slipDate!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  batchOrderCodes!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateIntakeCastingSlipFlaskDto)
  flasks!: CreateIntakeCastingSlipFlaskDto[];
}

export class ListCastingSlipsQuery {
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
