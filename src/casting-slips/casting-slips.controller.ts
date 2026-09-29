import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { BlockWorker, CurrentUser } from '../auth/decorators';
import type { AuthUserPayload } from '../auth/types';
import { CastingSlipsService } from './casting-slips.service';
import {
  CreateIntakeCastingSlipDto,
  ListCastingSlipsQuery,
} from './dto/casting-slip.dto';

@Controller('casting-slips')
export class CastingSlipsController {
  constructor(private readonly slips: CastingSlipsService) {}

  @Get()
  @BlockWorker()
  list(@Query() query: ListCastingSlipsQuery) {
    return this.slips.list(query);
  }

  @Get(':id')
  @BlockWorker()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.slips.getById(id);
  }

  @Post('from-intake/:intakeOrderId')
  @BlockWorker()
  createFromIntake(
    @Param('intakeOrderId', ParseUUIDPipe) intakeOrderId: string,
    @Body() dto: CreateIntakeCastingSlipDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.slips.createFromIntake(intakeOrderId, dto, user);
  }
}
