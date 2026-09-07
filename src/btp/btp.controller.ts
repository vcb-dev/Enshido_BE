import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserPayload } from '../auth/types';
import { BtpService } from './btp.service';
import { UpsertBtpWaitingDto } from './dto/waiting-item.dto';

@Controller('warehouses/:code/btp-waiting')
export class BtpController {
  constructor(private readonly btp: BtpService) {}

  @Get()
  list(@Param('code') code: string) {
    return this.btp.list(code);
  }

  @Post()
  create(
    @Param('code') code: string,
    @Body() dto: UpsertBtpWaitingDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.btp.create(code, dto, user);
  }

  @Patch(':id')
  update(
    @Param('code') code: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertBtpWaitingDto,
  ) {
    return this.btp.update(code, id, dto);
  }

  @Delete(':id')
  remove(
    @Param('code') code: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.btp.remove(code, id);
  }
}
