import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { WarehousesController } from './warehouses.controller';

@Module({
  imports: [InventoryModule],
  controllers: [WarehousesController],
})
export class WarehousesModule {}
