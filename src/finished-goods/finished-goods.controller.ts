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
  ListShipmentsQuery,
  ReceiveReceiptDto,
  StockQuery,
  UpsertReceiptDto,
  UpsertShipmentDto,
} from './dto/shipment.dto';
import { FinishedGoodsService } from './finished-goods.service';

@Controller('finished-goods')
export class FinishedGoodsController {
  constructor(private readonly finishedGoods: FinishedGoodsService) {}

  @Get('stock')
  stock(@Query() query: StockQuery) {
    return this.finishedGoods.stock(query.search);
  }

  @Get('receipts')
  receipts(@Query() query: StockQuery) {
    return this.finishedGoods.receipts(query.search);
  }

  @Get('order-options')
  orderOptions(@Query() query: StockQuery) {
    return this.finishedGoods.orderOptions(query.search);
  }

  @Get('nvl-options')
  nvlOptions(@Query() query: StockQuery) {
    return this.finishedGoods.nvlOptions(query.search);
  }

  @Post('receipts')
  createReceipt(
    @Body() dto: UpsertReceiptDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.finishedGoods.createReceipt(dto, user);
  }

  @Post('receipts/:id/receive')
  receiveReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveReceiptDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.finishedGoods.receiveReceipt(id, dto, user);
  }

  @Patch('receipts/:id')
  updateReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertReceiptDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.finishedGoods.updateReceipt(id, dto, user);
  }

  @Delete('receipts/:id')
  deleteReceipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.finishedGoods.deleteReceipt(id);
  }

  @Get('lookups')
  lookups() {
    return this.finishedGoods.lookups();
  }

  @Get('shipments')
  shipments(@Query() query: ListShipmentsQuery) {
    return this.finishedGoods.listShipments(query);
  }

  @Get('shipments/:code')
  shipment(@Param('code') code: string) {
    return this.finishedGoods.shipment(code);
  }

  @Post('shipments')
  create(@Body() dto: UpsertShipmentDto, @CurrentUser() user: AuthUserPayload) {
    return this.finishedGoods.create(dto, user);
  }

  @Patch('shipments/:code')
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
  markPrinted(@Param('code') code: string) {
    return this.finishedGoods.markPrinted(code);
  }
}
