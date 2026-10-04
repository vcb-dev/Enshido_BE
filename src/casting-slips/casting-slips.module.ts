import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CastingSlipsController } from './casting-slips.controller';
import { CastingSlipsService } from './casting-slips.service';

@Module({
  imports: [UploadsModule, InventoryModule],
  controllers: [CastingSlipsController],
  providers: [CastingSlipsService],
  exports: [CastingSlipsService],
})
export class CastingSlipsModule {}
