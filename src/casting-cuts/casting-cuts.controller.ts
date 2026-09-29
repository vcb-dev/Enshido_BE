import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { BlockWorker, CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { CastingCutsService } from './casting-cuts.service';
import {
  CreateCastingCutDto,
  DeleteCastingCutDto,
  ListCastingCutsQuery,
} from './dto/casting-cut.dto';

/** Phiếu cắt cây thông (bước 10) — thủ kho chia phôi cho đơn sau Đúc. */
@Controller('casting-cuts')
@BlockWorker()
export class CastingCutsController {
  constructor(private readonly cuts: CastingCutsService) {}

  @Get()
  list(@Query() query: ListCastingCutsQuery) {
    return this.cuts.list(query);
  }

  @Get('order-options')
  orderOptions(@Query('search') search?: string) {
    return this.cuts.orderOptions(search);
  }

  @Get('rest-material-options')
  restMaterialOptions() {
    return this.cuts.restMaterialOptions();
  }

  @Get('casting-slip-options')
  castingSlipOptions() {
    return this.cuts.castingSlipOptions();
  }

  @Get('casting-order-options')
  castingOrderOptions() {
    return this.cuts.castingOrderOptions();
  }

  @Get(':code')
  detail(@Param('code') code: string) {
    return this.cuts.detail(code);
  }

  @Post()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER, Permission.PRODUCTION_QC)
  create(
    @Body() dto: CreateCastingCutDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.cuts.create(dto, user);
  }

  @Post(':code/printed')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER, Permission.PRODUCTION_QC)
  markPrinted(@Param('code') code: string) {
    return this.cuts.markPrinted(code);
  }

  @Delete(':code')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER, Permission.PRODUCTION_QC)
  remove(
    @Param('code') code: string,
    @Body() dto: DeleteCastingCutDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.cuts.remove(code, dto.reason, user);
  }
}
