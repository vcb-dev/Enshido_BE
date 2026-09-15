import { Module } from '@nestjs/common';
import { ProductionOrdersModule } from '../production-orders/production-orders.module';
import { FinishedGoodsController } from './finished-goods.controller';
import { FinishedGoodsService } from './finished-goods.service';

@Module({
  imports: [ProductionOrdersModule],
  controllers: [FinishedGoodsController],
  providers: [FinishedGoodsService],
})
export class FinishedGoodsModule {}
