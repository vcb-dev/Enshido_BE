import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { ProductionOrdersController } from './production-orders.controller';
import { ProductionCostingService } from './production-costing.service';
import { ProductionOrdersService } from './production-orders.service';

@Module({
  imports: [UploadsModule],
  controllers: [ProductionOrdersController],
  providers: [ProductionOrdersService, ProductionCostingService],
  exports: [ProductionCostingService],
})
export class ProductionOrdersModule {}
