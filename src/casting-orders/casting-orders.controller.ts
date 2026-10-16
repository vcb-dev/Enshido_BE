import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  BlockWorker,
  CurrentUser,
  RequirePermissions,
} from '../auth/decorators';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { CastingOrdersService } from './casting-orders.service';
import {
  CreateCastingOrderDto,
  ListCastingOrdersQuery,
} from './dto/casting-order.dto';

@Controller('casting-orders')
export class CastingOrdersController {
  constructor(private readonly orders: CastingOrdersService) {}

  @Get()
  @BlockWorker()
  list(@Query() query: ListCastingOrdersQuery) {
    return this.orders.list(query);
  }

  @Get('nvl-options')
  @BlockWorker()
  nvlOptions() {
    return this.orders.nvlOptions();
  }

  @Post()
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  create(@Body() dto: CreateCastingOrderDto) {
    return this.orders.create(dto);
  }

  @Patch(':id')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCastingOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.update(id, dto, user);
  }
}
