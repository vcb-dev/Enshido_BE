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
  HandoverInfoDto,
  HandoverStageDto,
  ListProductionOrdersQuery,
  OpenSubTicketStageDto,
  OpenOrderStageDto,
  OrderCostDto,
  OrderOptionsQuery,
  ReturnStageDto,
  StageLaborDto,
  StartStageDto,
  SplitSubTicketsDto,
  SubTicketDto,
  SubTicketOutcomeDto,
  SubTicketTopUpDto,
  UpsertProductionOrderDto,
} from './dto/production-order.dto';
import { ProductionCostingService } from './production-costing.service';
import { ProductionOrdersService } from './production-orders.service';
import { ProductionSubTicketsService } from './production-sub-tickets.service';

@Controller('production-orders')
export class ProductionOrdersController {
  constructor(
    private readonly orders: ProductionOrdersService,
    private readonly costing: ProductionCostingService,
    private readonly subTickets: ProductionSubTicketsService,
  ) {}

  @Get()
  @BlockWorker()
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

  /** Màn "Phiếu của tôi" của thợ. */
  @Get('my-tickets')
  @RequirePermissions(Permission.PRODUCTION_WORKER)
  myTickets(@CurrentUser() user: AuthUserPayload) {
    return this.subTickets.myTickets(user);
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
  ) {
    return this.orders.updateCost(code, costId, dto);
  }

  @Patch(':code/stages/:stageId/labor')
  @BlockWorker()
  updateStageLabor(
    @Param('code') code: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: StageLaborDto,
  ) {
    return this.orders.updateStageLabor(code, stageId, dto);
  }

  @Delete(':code/costs/:costId')
  @BlockWorker()
  removeCost(
    @Param('code') code: string,
    @Param('costId', ParseUUIDPipe) costId: string,
  ) {
    return this.orders.removeCost(code, costId);
  }

  /** Thông tin đơn chỉ-đọc cho thợ quét QR trên phiếu giấy đã in. */
  @Get(':code/reference')
  reference(@Param('code') code: string) {
    return this.orders.reference(code);
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
  remove(@Param('code') code: string) {
    return this.orders.remove(code);
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
  cancelOrderPending(@Param('code') code: string) {
    return this.subTickets.cancelOrderPending(code);
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

  @Post(':code/sub-tickets/open-stage')
  @BlockWorker()
  openSubTicketStage(
    @Param('code') code: string,
    @Body() dto: OpenSubTicketStageDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.openStage(code, dto, user);
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
  ) {
    return this.subTickets.cancelPending(code, no);
  }

  @Post(':code/sub-tickets/:no/claim')
  @RequirePermissions(Permission.PRODUCTION_WORKER)
  claimSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.claim(code, no, user);
  }

  @Delete(':code/sub-tickets/:no/claim')
  unclaimSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.unclaim(code, no, user);
  }

  /** Cấp thêm SL / bạc cho phiếu con khi thợ làm giữa chừng phát hiện thiếu. */
  @Post(':code/sub-tickets/:no/top-up')
  @BlockWorker()
  topUpSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: SubTicketTopUpDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.topUp(code, no, dto, user);
  }

  /** Thợ báo đã làm xong khâu đang giữ, nộp hàng cho KCS. */
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

  @Post(':code/sub-tickets/:no/handover')
  handoverSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: HandoverInfoDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.handover(code, no, dto, user);
  }

  /** Chốt phiếu con ở nhánh Lỗi — lý do bắt buộc. */
  @Post(':code/sub-tickets/:no/defect')
  defectSubTicket(
    @Param('code') code: string,
    @Param('no', ParseIntPipe) no: number,
    @Body() dto: SubTicketOutcomeDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.subTickets.setOutcome(
      code,
      no,
      SubTicketOutcome.DEFECT,
      dto,
      user,
    );
  }

  /** Chốt phiếu con ở nhánh Hoàn thiện — số lượng phiếu vào kho thành phẩm. */
  @Post(':code/sub-tickets/:no/finish')
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
  ) {
    return this.subTickets.markPrinted(code, no);
  }
}
