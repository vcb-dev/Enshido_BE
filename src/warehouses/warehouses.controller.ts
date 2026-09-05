import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateInboundDto } from '../inventory/dto/inbound.dto';
import { CreateOutboundDto } from '../inventory/dto/outbound.dto';
import { CreateStockDto, UpdateStockDto } from '../inventory/dto/update-stock.dto';
import { InventoryService } from '../inventory/inventory.service';

@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @Header('Cache-Control', 'private, max-age=60')
  list() {
    return this.inventory.listWarehouses();
  }

  @Get(':code/inbounds')
  inbounds(@Param('code') code: string) {
    return this.inventory.listInbounds(code);
  }

  @Post(':code/inbounds')
  createInbound(@Param('code') code: string, @Body() dto: CreateInboundDto) {
    return this.inventory.createInbound(code, dto);
  }

  @Patch(':code/inbounds/:inboundId')
  updateInbound(
    @Param('code') code: string,
    @Param('inboundId', ParseUUIDPipe) inboundId: string,
    @Body() dto: CreateInboundDto,
  ) {
    return this.inventory.updateInbound(code, inboundId, dto);
  }

  @Delete(':code/inbounds/:inboundId')
  deleteInbound(
    @Param('code') code: string,
    @Param('inboundId', ParseUUIDPipe) inboundId: string,
  ) {
    return this.inventory.deleteInbound(code, inboundId);
  }

  @Get(':code/outbounds')
  outbounds(@Param('code') code: string) {
    return this.inventory.listOutbounds(code);
  }

  @Post(':code/outbounds')
  createOutbound(@Param('code') code: string, @Body() dto: CreateOutboundDto) {
    return this.inventory.createOutbound(code, dto);
  }

  @Patch(':code/outbounds/:outboundId')
  updateOutbound(
    @Param('code') code: string,
    @Param('outboundId', ParseUUIDPipe) outboundId: string,
    @Body() dto: CreateOutboundDto,
  ) {
    return this.inventory.updateOutbound(code, outboundId, dto);
  }

  @Delete(':code/outbounds/:outboundId')
  deleteOutbound(
    @Param('code') code: string,
    @Param('outboundId', ParseUUIDPipe) outboundId: string,
  ) {
    return this.inventory.deleteOutbound(code, outboundId);
  }

  @Get(':code/stock')
  stock(@Param('code') code: string) {
    return this.inventory.listStock(code);
  }

  @Post(':code/stock')
  createStock(@Param('code') code: string, @Body() dto: CreateStockDto) {
    return this.inventory.createStock(code, dto);
  }

  @Patch(':code/stock/:materialId')
  updateStock(
    @Param('code') code: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Body() dto: UpdateStockDto,
  ) {
    return this.inventory.updateStock(code, materialId, dto);
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.inventory.getWarehouse(code);
  }
}
