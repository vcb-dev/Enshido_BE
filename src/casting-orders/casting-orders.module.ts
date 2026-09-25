import { Module } from '@nestjs/common';
import { CastingOrdersController } from './casting-orders.controller';
import { CastingOrdersService } from './casting-orders.service';

@Module({
  controllers: [CastingOrdersController],
  providers: [CastingOrdersService],
})
export class CastingOrdersModule {}
