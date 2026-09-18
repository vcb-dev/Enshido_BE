import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { UploadsModule } from '../uploads/uploads.module';
import { ProductionOrdersController } from './production-orders.controller';
import { ProductionCostingService } from './production-costing.service';
import { ProductionOrdersService } from './production-orders.service';
import { ProductionSubTicketsService } from './production-sub-tickets.service';

@Module({
  imports: [UploadsModule, InventoryModule],
  controllers: [ProductionOrdersController],
  providers: [
    ProductionOrdersService,
    ProductionCostingService,
    ProductionSubTicketsService,
  ],
  exports: [ProductionCostingService],
})
export class ProductionOrdersModule {}
