import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';

export class GenerateLocationsDto {
  @IsString()
  warehouseCode!: string;

  @Matches(/^[A-Za-z]$/, { message: 'Zone phải là một chữ cái' })
  zone!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  aisleCount!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(26)
  levelCount!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  positionCount!: number;
}

export class UpdateLocationDto {
  @Matches(/^[A-Za-z]$/, { message: 'Zone phải là một chữ cái' })
  zone!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  aisle!: number;

  @Matches(/^[A-Za-z]$/, { message: 'Tầng phải là một chữ cái' })
  level!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  position!: number;
}
