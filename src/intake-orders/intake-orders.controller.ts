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
import { BlockWorker, CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import {
  ApproveIntakeOrderDto,
  ConfirmWarehouseDto,
  WaxPrintBatchDto,
  IntakeModel3dDto,
  IntakeCastingTreeSpecsDto,
  IntakeProductSpecsDto,
  IntakeWaxPrintBatchDto,
  RejectIntakeOrderDto,
  IntakePipelineListsQuery,
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

  @Get('pipeline-counts')
  @BlockWorker()
  pipelineCounts() {
    return this.orders.pipelineStatusCounts();
  }

  @Get('pipeline-lists')
  @BlockWorker()
  pipelineLists(@Query() query: IntakePipelineListsQuery) {
    return this.orders.pipelineLists(query);
  }

  @Post()
  @BlockWorker()
  @RequirePermissions(Permission.INTAKE_CREATE)
  create(@Body() dto: UpsertIntakeOrderDto, @CurrentUser() user: AuthUserPayload) {
    return this.orders.create(dto, user);
  }

  @Post(':id/approve')
  @BlockWorker()
  @RequirePermissions(Permission.INTAKE_APPROVE)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveIntakeOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.approve(id, dto, user);
  }

  @Post(':id/model-3d')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_MODEL3D)
  attachModel3d(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IntakeModel3dDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.attachModel3d(id, dto, user);
  }

  /** Bước 4: in sáp nhiều đơn một lần, ảnh cả khay + cân nặng từng đơn. */
  @Post('wax-print')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_MODEL3D)
  waxPrintBatch(@Body() dto: WaxPrintBatchDto) {
    return this.orders.waxPrintBatch(dto);
  }

  @Post(':id/product-specs')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_MODEL3D, Permission.PRODUCTION_WAX)
  submitProductSpecs(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IntakeProductSpecsDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.submitProductSpecs(id, dto, user);
  }

  /** Bước 4: thợ 3D nhập một lượt in sáp nhiều đơn (ảnh cả khay + cân từng đơn). */
  @Post('wax-print-batch')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_MODEL3D)
  submitWaxPrintBatch(@Body() dto: IntakeWaxPrintBatchDto) {
    return this.orders.submitWaxPrintBatch(dto);
  }

  @Post(':id/confirm-warehouse')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  confirmWarehouse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmWarehouseDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.confirmWarehouseSpecs(id, dto, user);
  }

  @Post(':id/casting-tree-specs')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_WAX)
  submitCastingTreeSpecs(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IntakeCastingTreeSpecsDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.submitCastingTreeSpecs(id, dto, user);
  }

  @Post(':id/reject')
  @BlockWorker()
  @RequirePermissions(Permission.INTAKE_APPROVE)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectIntakeOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.reject(id, dto, user);
  }

  @Patch(':id')
  @BlockWorker()
  @RequirePermissions(Permission.INTAKE_CREATE, Permission.INTAKE_APPROVE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertIntakeOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.update(id, dto, user);
  }

  @Delete(':id')
  @BlockWorker()
  @RequirePermissions(Permission.INTAKE_APPROVE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.remove(id);
  }
}
