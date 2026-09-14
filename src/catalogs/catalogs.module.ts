import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { CatalogsController } from './catalogs.controller';
import { CatalogsService } from './catalogs.service';

@Module({
  imports: [InventoryModule],
  controllers: [CatalogsController],
  providers: [CatalogsService],
})
export class CatalogsModule {}
