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
import {
  BlockWorker,
  CurrentUser,
  RequirePermissions,
  Roles,
} from '../auth/decorators';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import {
  ListShipmentsQuery,
  ReceiveReceiptDto,
  StockQuery,
  UpsertReceiptDto,
  UpsertShipmentDto,
} from './dto/shipment.dto';
import { FinishedGoodsService } from './finished-goods.service';

/**
 * Kho thành phẩm + phiếu xuất hàng (mô tả luồng bước 22–23): tài khoản thợ không vào được; nhập /
 * sửa kho và lập phiếu xuất là việc của thủ kho, kế toán xác nhận phiếu xuất.
 */
/** Xem kho thành phẩm và phiếu xuất: thủ kho, kế toán, người được tick màn Kho thành phẩm. */
const FINISHED_GOODS_READERS = [
  Permission.SCREEN_WAREHOUSE_THANH_PHAM,
  Permission.WAREHOUSE_KEEPER,
  Permission.ACCOUNTING_APPROVE,
] as const;

@Controller('finished-goods')
@BlockWorker()
export class FinishedGoodsController {
  constructor(private readonly finishedGoods: FinishedGoodsService) {}

  @Get('stock')
  @RequirePermissions(...FINISHED_GOODS_READERS)
  stock(@Query() query: StockQuery) {
    return this.finishedGoods.stock(query.search);
  }

  @Get('receipts')
  @RequirePermissions(...FINISHED_GOODS_READERS)
  receipts(@Query() query: StockQuery) {
    return this.finishedGoods.receipts(query.search);
  }

  @Get('order-options')
  @RequirePermissions(...FINISHED_GOODS_READERS)
  orderOptions(@Query() query: StockQuery) {
    return this.finishedGoods.orderOptions(query.search);
  }

  @Get('nvl-options')
  @RequirePermissions(...FINISHED_GOODS_READERS)
  nvlOptions(@Query() query: StockQuery) {
    return this.finishedGoods.nvlOptions(query.search);
  }

  @Post('receipts')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  createReceipt(
    @Body() dto: UpsertReceiptDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.finishedGoods.createReceipt(dto, user);
  }

  // Mô tả luồng bước 22: thủ kho xác nhận nhập kho thành phẩm (U → V).
  @Post('receipts/:id/receive')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  receiveReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveReceiptDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.finishedGoods.receiveReceipt(id, dto, user);
  }

  @Patch('receipts/:id')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  updateReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertReceiptDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.finishedGoods.updateReceipt(id, dto, user);
  }

  @Delete('receipts/:id')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  deleteReceipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.finishedGoods.deleteReceipt(id);
  }

  @Get('lookups')
  @RequirePermissions(...FINISHED_GOODS_READERS)
  lookups() {
    return this.finishedGoods.lookups();
  }

  @Get('shipments')
  @RequirePermissions(...FINISHED_GOODS_READERS)
  shipments(@Query() query: ListShipmentsQuery) {
    return this.finishedGoods.listShipments(query);
  }

  @Get('shipments/:code')
  @RequirePermissions(...FINISHED_GOODS_READERS)
  shipment(@Param('code') code: string) {
    return this.finishedGoods.shipment(code);
  }

  @Post('shipments')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  create(@Body() dto: UpsertShipmentDto, @CurrentUser() user: AuthUserPayload) {
    return this.finishedGoods.create(dto, user);
  }

  @Patch('shipments/:code')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  update(
    @Param('code') code: string,
    @Body() dto: UpsertShipmentDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.finishedGoods.update(code, dto, user);
  }

  @Delete('shipments/:code')
  @Roles(RoleCode.ADMIN)
  remove(@Param('code') code: string, @CurrentUser() user: AuthUserPayload) {
    return this.finishedGoods.remove(code, user);
  }

  @Post('shipments/:code/printed')
  @RequirePermissions(
    Permission.WAREHOUSE_KEEPER,
    Permission.ACCOUNTING_APPROVE,
  )
  markPrinted(@Param('code') code: string) {
    return this.finishedGoods.markPrinted(code);
  }

  // Mô tả luồng bước 23: kế toán xác nhận phiếu xuất — đơn mới tính Đã giao.
  @Post('shipments/:code/approve')
  @RequirePermissions(Permission.ACCOUNTING_APPROVE)
  approve(@Param('code') code: string, @CurrentUser() user: AuthUserPayload) {
    return this.finishedGoods.approve(code, user);
  }
}
