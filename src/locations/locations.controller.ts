import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import { GenerateLocationsDto, UpdateLocationDto } from './dto/location.dto';
import { LocationsService } from './locations.service';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  list(@Query('warehouseCode') warehouseCode = 'nvl-chinh') {
    return this.locations.list(warehouseCode);
  }

  @Post('generate')
  @RequirePermissions(Permission.SCREEN_LOCATIONS)
  generate(@Body() dto: GenerateLocationsDto) {
    return this.locations.generate(dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.SCREEN_LOCATIONS)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.locations.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.SCREEN_LOCATIONS)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.locations.remove(id);
  }
}
