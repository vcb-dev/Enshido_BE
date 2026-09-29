import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { UploadsModule } from '../uploads/uploads.module';
import { CastingCutsController } from './casting-cuts.controller';
import { CastingCutsService } from './casting-cuts.service';

@Module({
  imports: [InventoryModule, UploadsModule],
  controllers: [CastingCutsController],
  providers: [CastingCutsService],
})
export class CastingCutsModule {}
