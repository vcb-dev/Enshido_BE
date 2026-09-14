import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RoleCode } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUserPayload } from '../auth/types';
import {
  ListShipmentsQuery,
  StockQuery,
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
