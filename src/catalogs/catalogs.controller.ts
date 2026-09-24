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
import { OtherClassKind } from '@prisma/client';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUserPayload } from '../auth/types';
import { Permission } from '../auth/permissions';
import { CatalogsService } from './catalogs.service';
import {
  CreateOtherClassDto,
  UpdateOtherClassDto,
} from './dto/other-class.dto';

@Controller('catalogs')
export class CatalogsController {
  constructor(private readonly catalogs: CatalogsService) {}

  @Get()
  list(@Query('kind') kind?: OtherClassKind) {
    const resolved =
      kind === OtherClassKind.OTHER
        ? OtherClassKind.OTHER
        : OtherClassKind.CATALOG;
    return this.catalogs.list(resolved);
  }

  @Post()
  @RequirePermissions(Permission.SCREEN_CATALOGS)
  create(@Body() dto: CreateOtherClassDto) {
    return this.catalogs.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.SCREEN_CATALOGS)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOtherClassDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.catalogs.update(id, dto, user);
  }

  @Delete(':id')
  @RequirePermissions(Permission.SCREEN_CATALOGS)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalogs.remove(id);
  }
}
