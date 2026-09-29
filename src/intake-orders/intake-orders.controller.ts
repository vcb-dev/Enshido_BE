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
import { BlockWorker, CurrentUser } from '../auth/decorators';
import type { AuthUserPayload } from '../auth/types';
import {
  ApproveIntakeOrderDto,
  IntakeModel3dDto,
  IntakeCastingTreeSpecsDto,
  IntakeProductSpecsDto,
  RejectIntakeOrderDto,
  ListIntakeOrdersQuery,
  UpsertIntakeOrderDto,
} from './dto/intake-order.dto';
import { IntakeOrdersService } from './intake-orders.service';

@Controller('intake-orders')
export class IntakeOrdersController {
  constructor(private readonly orders: IntakeOrdersService) {}

  @Get()
  @BlockWorker()
  list(@Query() query: ListIntakeOrdersQuery) {
    return this.orders.list(query);
  }

  @Post()
  @BlockWorker()
  create(@Body() dto: UpsertIntakeOrderDto, @CurrentUser() user: AuthUserPayload) {
    return this.orders.create(dto, user);
  }

  @Post(':id/approve')
  @BlockWorker()
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveIntakeOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.approve(id, dto, user);
  }

  @Post(':id/model-3d')
  @BlockWorker()
  attachModel3d(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IntakeModel3dDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.attachModel3d(id, dto, user);
  }

  @Post(':id/product-specs')
  @BlockWorker()
  submitProductSpecs(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IntakeProductSpecsDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.submitProductSpecs(id, dto, user);
  }

  @Post(':id/confirm-warehouse')
  @BlockWorker()
  confirmWarehouse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.confirmWarehouseSpecs(id, user);
  }

  @Post(':id/casting-tree-specs')
  @BlockWorker()
  submitCastingTreeSpecs(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IntakeCastingTreeSpecsDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.submitCastingTreeSpecs(id, dto, user);
  }

  @Post(':id/reject')
  @BlockWorker()
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectIntakeOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.reject(id, dto, user);
  }

  @Patch(':id')
  @BlockWorker()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertIntakeOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.update(id, dto, user);
  }

  @Delete(':id')
  @BlockWorker()
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.remove(id);
  }
}
