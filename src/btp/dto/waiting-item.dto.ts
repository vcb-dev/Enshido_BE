import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

const DECIMAL = /^-?\d+(\.\d+)?$/;

export class UpsertBtpWaitingDto {
  @IsDateString()
  receivedAt!: string;

  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  craftsmanUserId!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @IsUUID()
  unitId?: string | null;

  @IsOptional()
  @IsString()
  unitName?: string;

  @Matches(DECIMAL, { message: 'Số lượng không hợp lệ' })
  qty!: string;

  @Matches(DECIMAL, { message: 'Trọng lượng không hợp lệ' })
  weight!: string;

  @IsOptional()
  @IsString()
  note?: string;
}
