import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LossMetal, LossStage } from '@prisma/client';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export class LossReportQuery {
  /** Một ngày bất kỳ trong tuần đầu — server lùi về thứ Hai. */
  @Matches(DATE_KEY, { message: 'Tuần bắt đầu không hợp lệ' })
  from!: string;

  /** Một ngày bất kỳ trong tuần cuối. */
  @Matches(DATE_KEY, { message: 'Tuần kết thúc không hợp lệ' })
  to!: string;
}

export class LossLimitDto {
  @IsEnum(LossStage)
  stage!: LossStage;

  @IsEnum(LossMetal)
  metal!: LossMetal;

  /** null = bỏ mức của khâu này. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Mức hao hụt không hợp lệ' })
  @Min(0)
  @Max(100)
  percent?: number | null;
}

export class UpdateLossLimitsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LossLimitDto)
  limits!: LossLimitDto[];
}

export class CreateScrapReturnDto {
  @IsUUID(undefined, { message: 'Chưa chọn thợ' })
  craftsmanUserId!: string;

  /** Một ngày bất kỳ trong tuần mạt được tính vào. */
  @Matches(DATE_KEY, { message: 'Tuần không hợp lệ' })
  week!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'TL mạt không hợp lệ' })
  @Min(0.0001, { message: 'TL mạt phải lớn hơn 0' })
  @Max(100000)
  weightGram!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
