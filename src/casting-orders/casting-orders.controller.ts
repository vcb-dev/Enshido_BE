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
import { BlockWorker, CurrentUser } from '../auth/decorators';
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
  create(@Body() dto: CreateCastingOrderDto) {
    return this.orders.create(dto);
  }

  @Patch(':id')
  @BlockWorker()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCastingOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.update(id, dto, user);
  }
}
