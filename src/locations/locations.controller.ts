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
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUserPayload } from '../auth/types';
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
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.locations.update(id, dto, user);
  }

  @Delete(':id')
  @RequirePermissions(Permission.SCREEN_LOCATIONS)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.locations.remove(id);
  }
}
