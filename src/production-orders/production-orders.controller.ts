import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RoleCode } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUserPayload } from '../auth/types';
import {
  CastingDto,
  ChangeStatusDto,
  HandoverStageDto,
  ListProductionOrdersQuery,
  OrderCostDto,
  OrderOptionsQuery,
  ReturnStageDto,
  StartStageDto,
  UpsertProductionOrderDto,
} from './dto/production-order.dto';
import { ProductionCostingService } from './production-costing.service';
import { ProductionOrdersService } from './production-orders.service';

@Controller('production-orders')
export class ProductionOrdersController {
  constructor(
    private readonly orders: ProductionOrdersService,
    private readonly costing: ProductionCostingService,
  ) {}

  @Get()
  list(@Query() query: ListProductionOrdersQuery) {
    return this.orders.list(query);
  }

  @Get('lookups')
  lookups() {
    return this.orders.lookups();
  }

  @Get('options')
  options(@Query() query: OrderOptionsQuery) {
    return this.orders.options(query.search);
  }

  @Get(':code/costing')
  costingOf(@Param('code') code: string) {
    return this.costing.costingByCode(code);
  }

  @Post(':code/costs')
  addCost(
    @Param('code') code: string,
    @Body() dto: OrderCostDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.addCost(code, dto, user);
  }

  @Patch(':code/costs/:costId')
  updateCost(
    @Param('code') code: string,
    @Param('costId', ParseUUIDPipe) costId: string,
    @Body() dto: OrderCostDto,
  ) {
    return this.orders.updateCost(code, costId, dto);
  }

  @Delete(':code/costs/:costId')
  removeCost(
    @Param('code') code: string,
    @Param('costId', ParseUUIDPipe) costId: string,
  ) {
    return this.orders.removeCost(code, costId);
  }

  @Get(':code')
  detail(@Param('code') code: string) {
    return this.orders.detail(code);
  }

  @Post()
  create(
    @Body() dto: UpsertProductionOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.create(dto, user);
  }

  @Patch(':code')
  update(@Param('code') code: string, @Body() dto: UpsertProductionOrderDto) {
    return this.orders.update(code, dto);
  }

  @Delete(':code')
  @Roles(RoleCode.ADMIN)
  remove(@Param('code') code: string) {
    return this.orders.remove(code);
  }

  @Patch(':code/status')
  changeStatus(
    @Param('code') code: string,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.changeStatus(code, dto, user);
  }

  @Patch(':code/casting')
  updateCasting(
    @Param('code') code: string,
    @Body() dto: CastingDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.updateCasting(code, dto, user);
  }

  @Post(':code/stages')
  startStage(
    @Param('code') code: string,
    @Body() dto: StartStageDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.startStage(code, dto, user);
  }

  @Patch(':code/stages/:stageId')
  updateHandover(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: HandoverStageDto,
  ) {
    return this.orders.updateHandover(code, stageId, dto);
  }

  @Post(':code/stages/:stageId/return')
  returnStage(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: ReturnStageDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.returnStage(code, stageId, dto, user);
  }

  @Delete(':code/stages/:stageId/return')
  @Roles(RoleCode.ADMIN)
  undoReturn(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.undoReturn(code, stageId, user);
  }

  @Post(':code/printed')
  markPrinted(@Param('code') code: string) {
    return this.orders.markPrinted(code);
  }
}
