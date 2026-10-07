import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { RoleCode, SubTicketOutcome } from '@prisma/client';
import {
  BlockWorker,
  CurrentUser,
  RequirePermissions,
  Roles,
} from '../auth/decorators';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import {
  CastingDto,
  ChangeStatusDto,
  FinishOrderDto,
  AssignSubTicketDto,
  SkipStoneDto,
  StageDefectDto,
  HandoverInfoDto,
  ListProductionOrdersQuery,
  OpenOrderStageDto,
  OrderCostDto,
  OrderOptionsQuery,
  ReturnStageDto,
  StageLaborDto,
  SplitSubTicketsDto,
  SubTicketDto,
  SubTicketOutcomeDto,
  UpsertProductionOrderDto,
  IssueMaterialRequestDto,
  MaterialRequestDto,
  EarlyStoneReturnDto,
  MaterialRequestListQuery,
  RejectMaterialRequestDto,
} from './dto/production-order.dto';
import { ProductionCostingService } from './production-costing.service';
import { ProductionMaterialRequestsService } from './production-material-requests.service';
import { ProductionOrdersService } from './production-orders.service';
import { ProductionSubTicketsService } from './production-sub-tickets.service';

@Controller('production-orders')
export class ProductionOrdersController {
  constructor(
    private readonly orders: ProductionOrdersService,
    private readonly costing: ProductionCostingService,
    private readonly subTickets: ProductionSubTicketsService,
    private readonly materials: ProductionMaterialRequestsService,
  ) {}

  /** Hàng chờ xuất NVL của kho — yêu cầu thợ xin trong lúc làm khâu. */
  @Get('material-requests')
  @BlockWorker()
  listMaterialRequests(@Query() query: MaterialRequestListQuery) {
    return this.materials.list(query.status);
  }

  /** Thợ huỷ yêu cầu xuất NVL chưa được xuất. */
  @Delete('material-requests/:id')
  cancelMaterialRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.materials.cancel(id, user);
  }

  /** Kho / người giao cân rồi xuất theo yêu cầu — tạo phiếu xuất gắn mã đơn. */
  @Post('material-requests/:id/issue')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  @BlockWorker()
  issueMaterialRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueMaterialRequestDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.materials.issue(id, dto, user);
  }

  @Post('material-requests/:id/reject')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  @BlockWorker()
  rejectMaterialRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectMaterialRequestDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.materials.reject(id, dto, user);
  }

  /** Thợ xin xuất NVL cho khâu đang làm trên phiếu mẹ (đơn chưa chia). */
  @Post(':code/work/material-requests')
  requestOrderMaterial(
    @Param('code') code: string,
    @Body() dto: MaterialRequestDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.materials.create(code, null, dto, user);
  }

  /** Thợ xin xuất NVL cho khâu đang làm trên phiếu con. */
  @Post(':code/sub-tickets/:no/material-requests')
  requestSubTicketMaterial(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: MaterialRequestDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.materials.create(code, no, dto, user);
  }

  @Get()
  @BlockWorker()
  list(@Query() query: ListProductionOrdersQuery) {
    return this.orders.list(query);
  }

  @Get('lookups')
  lookups() {
    return this.orders.lookups();
  }

  /** Badge tab Lệnh sản xuất — cache ngắn, tách khỏi GET list để phân trang nhanh hơn. */
  @Get('status-counts')
  @BlockWorker()
  statusCounts(@Query() query: ListProductionOrdersQuery) {
    return this.orders.listStatusCounts(query);
  }

  @Get('options')
  options(@Query() query: OrderOptionsQuery) {
    return this.orders.options(query.search);
  }

  /** Mã BTP còn tồn cho ô chọn khi lên Đơn BTP. */
  @Get('btp-options')
  btpOptions(@Query() query: OrderOptionsQuery) {
    return this.orders.btpOptions(query.search);
  }

  @Get('finished-product-options')
  finishedProductOptions(@Query() query: OrderOptionsQuery) {
    return this.orders.finishedProductOptions(query.search);
  }

  @Get('nvl-options')
  nvlOptions(@Query() query: OrderOptionsQuery) {
    return this.orders.nvlOptions(query.search);
  }

  /** Màn "Phiếu của tôi" của thợ sản xuất và thợ đúc. */
  @Get('my-tickets')
  @RequirePermissions(Permission.PRODUCTION_WORKER, Permission.PRODUCTION_CAST)
  myTickets(@CurrentUser() user: AuthUserPayload) {
    return this.subTickets.myTickets(user);
  }

  /** Màn "Phiếu QC": chờ QC cân lại, chờ thủ kho xác nhận, chờ hoàn thiện, gần đây. */
  @Get('qc-tickets')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_QC)
  qcTickets(@CurrentUser() user: AuthUserPayload) {
    return this.subTickets.qcTickets(user);
  }

  @Get(':code/costing')
  @BlockWorker()
  costingOf(@Param('code') code: string) {
    return this.costing.costingByCode(code);
  }

  /** Chi tiết đơn xem từ mã phiếu con — đường dành cho trang phiếu con và thợ. */
  @Get('tickets/:ticketCode')
  ticketDetail(@Param('ticketCode') ticketCode: string) {
    return this.subTickets.detailByTicket(ticketCode);
  }

  @Post(':code/costs')
  @BlockWorker()
  addCost(
    @Param('code') code: string,
    @Body() dto: OrderCostDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.addCost(code, dto, user);
  }

  @Patch(':code/costs/:costId')
  @BlockWorker()
  updateCost(
    @Param('code') code: string,
    @Param('costId', ParseUUIDPipe) costId: string,
    @Body() dto: OrderCostDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.updateCost(code, costId, dto, user);
  }

  @Patch(':code/stages/:stageId/labor')
  @BlockWorker()
  updateStageLabor(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: StageLaborDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.updateStageLabor(code, stageId, dto, user);
  }

  @Delete(':code/costs/:costId')
  @BlockWorker()
  removeCost(
    @Param('code') code: string,
    @Param('costId', ParseUUIDPipe) costId: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.removeCost(code, costId, user);
  }

  /** Thông tin đơn chỉ-đọc cho thợ quét QR trên phiếu giấy đã in. */
  @Get(':code/reference')
  reference(@Param('code') code: string) {
    return this.orders.reference(code);
  }

  @Get(':code/activity')
  @BlockWorker()
  activityLog(@Param('code') code: string) {
    return this.orders.activityLog(code);
  }

  @Get(':code')
  @BlockWorker()
  detail(@Param('code') code: string) {
    return this.orders.detail(code);
  }

  @Post()
  @BlockWorker()
  create(
    @Body() dto: UpsertProductionOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.create(dto, user);
  }

  @Patch(':code')
  @BlockWorker()
  update(
    @Param('code') code: string,
    @Body() dto: UpsertProductionOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.update(code, dto, user);
  }

  @Delete(':code')
  @Roles(RoleCode.ADMIN)
  remove(@Param('code') code: string, @CurrentUser() user: AuthUserPayload) {
    return this.orders.remove(code, user);
  }

  @Patch(':code/status')
  @BlockWorker()
  changeStatus(
    @Param('code') code: string,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.changeStatus(code, dto, user);
  }

  @Patch(':code/casting')
  @BlockWorker()
  updateCasting(
    @Param('code') code: string,
    @Body() dto: CastingDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.updateCasting(code, dto, user);
  }

  @Post(':code/finish')
  @RequirePermissions(Permission.PRODUCTION_QC)
  @BlockWorker()
  finish(
    @Param('code') code: string,
    @Body() dto: FinishOrderDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.finish(code, dto, user);
  }

  @Delete(':code/finish')
  @Roles(RoleCode.ADMIN)
  undoFinish(
    @Param('code') code: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.undoFinish(code, user);
  }

  @Post(':code/stages/:stageId/return')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_QC)
  returnStage(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: ReturnStageDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.returnStage(code, stageId, dto, user);
  }

  /** Thủ kho nhận lại túi đá thợ trả giữa khâu Vào đá (đổi size) — nhả giữ chỗ phần trả. */
  @Post(':code/stages/:stageId/stone-returns')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  returnStoneEarly(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: EarlyStoneReturnDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.returnStoneEarly(code, stageId, dto, user);
  }

  /** Thủ kho xác nhận sau QC (Nguội / Vào đá): nhập kho BTP hàng đạt, NVL hàng lỗi + thừa. */
  @Post(':code/stages/:stageId/confirm')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  confirmStage(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.confirmStage(code, stageId, user);
  }

  /** QC sửa lại kết quả đã nhận ở Nguội / Vào đá — tối đa 3 lần, trước khi thủ kho xác nhận. */
  @Put(':code/stages/:stageId/return')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_QC)
  reviseReturn(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: ReturnStageDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.returnStage(code, stageId, dto, user, true);
  }

  /** Thủ kho tạo phiếu bù cho hàng lỗi QC đã tách (Nguội / Vào đá) — đi lại từ bước sáp. */
  @Post(':code/stages/:stageId/rework')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  createRework(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.createRework(code, stageId, user);
  }

  /** Thủ kho đánh dấu / bỏ đánh dấu đơn không có đá — các phiếu nguội xong sang thẳng Chờ khắc. */
  @Post(':code/skip-stone')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  setStoneSkipped(
    @Param('code') code: string,
    @Body() dto: SkipStoneDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.setStoneSkipped(code, dto.skip, user);
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
  markPrinted(
    @Param('code') code: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.orders.markPrinted(code, user);
  }

  @Post(':code/sub-tickets')
  @BlockWorker()
  createSubTicket(
    @Param('code') code: string,
    @Body() dto: SubTicketDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.create(code, dto, user);
  }

  @Post(':code/work/open-stage')
  @BlockWorker()
  openOrderStage(
    @Param('code') code: string,
    @Body() dto: OpenOrderStageDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.openOrderStage(code, dto, user);
  }

  @Delete(':code/work/pending')
  @BlockWorker()
  cancelOrderPending(
    @Param('code') code: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.cancelOrderPending(code, user);
  }

  @Post(':code/work/claim')
  @RequirePermissions(Permission.PRODUCTION_WORKER)
  claimOrder(
    @Param('code') code: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.claimOrder(code, user);
  }

  @Delete(':code/work/claim')
  unclaimOrder(
    @Param('code') code: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.unclaimOrder(code, user);
  }

  @Post(':code/work/handover')
  handoverOrder(
    @Param('code') code: string,
    @Body() dto: HandoverInfoDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.handoverOrder(code, dto, user);
  }

  @Post(':code/work/submit')
  submitOrder(
    @Param('code') code: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.submitOrder(code, user);
  }

  @Delete(':code/work/submit')
  unsubmitOrder(
    @Param('code') code: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.unsubmitOrder(code, user);
  }

  /** Chia đơn lần đầu: luôn tạo từ hai phiếu con trở lên trong cùng một transaction. */
  @Post(':code/sub-tickets/split')
  @BlockWorker()
  splitSubTickets(
    @Param('code') code: string,
    @Body() dto: SplitSubTicketsDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.split(code, dto, user);
  }

  /** Hủy chia khi chưa phiếu nào bắt đầu làm, quay lại quy trình trên phiếu mẹ. */
  @Delete(':code/sub-tickets')
  @BlockWorker()
  clearSubTickets(
    @Param('code') code: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.clearSplit(code, user);
  }

  @Patch(':code/sub-tickets/:no')
  @BlockWorker()
  updateSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: SubTicketDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.update(code, no, dto, user);
  }

  @Delete(':code/sub-tickets/:no')
  @BlockWorker()
  removeSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.remove(code, no, user);
  }

  @Delete(':code/sub-tickets/:no/pending')
  cancelSubTicketPending(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.cancelPending(code, no, user);
  }

  /** Thủ kho chỉ định thợ cho khâu kế tiếp của phiếu con. */
  @Post(':code/sub-tickets/:no/assign')
  @BlockWorker()
  assignSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: AssignSubTicketDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.assign(code, no, dto, user);
  }

  /** Thợ được chỉ định quét QR, bấm nhận hàng — hệ thống ghi giao khâu và xuất kho phôi. */
  @Post(':code/sub-tickets/:no/accept')
  @RequirePermissions(Permission.PRODUCTION_WORKER)
  acceptSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.accept(code, no, user);
  }

  @Delete(':code/sub-tickets/:no/claim')
  unclaimSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.unclaim(code, no, user);
  }

  /** Thợ báo đã làm xong khâu đang giữ, nộp hàng cho QC. */
  @Post(':code/sub-tickets/:no/submit')
  submitSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.submit(code, no, user);
  }

  @Delete(':code/sub-tickets/:no/submit')
  unsubmitSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.unsubmit(code, no, user);
  }

  /** Báo lỗi ở khâu đang làm: thợ giữ khâu, QC hoặc admin (lý do bắt buộc). */
  @Post(':code/sub-tickets/:no/stage-defect')
  reportStageDefect(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: StageDefectDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.reportStageDefect(code, no, dto, user);
  }

  @Delete(':code/sub-tickets/:no/stage-defect')
  clearStageDefect(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.clearStageDefect(code, no, user);
  }

  @Post(':code/sub-tickets/:no/handover')
  handoverSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: HandoverInfoDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.handover(code, no, dto, user);
  }

  /** Chốt phiếu con ở nhánh Hoàn thiện — số lượng phiếu vào kho thành phẩm. */
  @Post(':code/sub-tickets/:no/finish')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_QC)
  finishSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: SubTicketOutcomeDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.setOutcome(
      code,
      no,
      SubTicketOutcome.FINISH,
      dto,
      user,
    );
  }

  @Delete(':code/sub-tickets/:no/outcome')
  @Roles(RoleCode.ADMIN)
  clearSubTicketOutcome(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.clearOutcome(code, no, user);
  }

  @Post(':code/sub-tickets/:no/printed')
  markSubTicketPrinted(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.markPrinted(code, no, user);
  }
}
