import { Controller, Get, Header } from '@nestjs/common';
import { InventoryService } from './inventory.service';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('lookups')
  @Header('Cache-Control', 'private, max-age=300')
  lookups() {
    return this.inventory.listLookups();
  }
}
