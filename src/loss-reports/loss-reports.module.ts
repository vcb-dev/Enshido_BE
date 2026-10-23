import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { LossReportsController } from './loss-reports.controller';
import { LossReportsService } from './loss-reports.service';

@Module({
  imports: [InventoryModule],
  controllers: [LossReportsController],
  providers: [LossReportsService],
})
export class LossReportsModule {}
