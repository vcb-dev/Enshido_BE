import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  BlockWorker,
  CurrentUser,
  RequirePermissions,
} from '../auth/decorators';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import {
  CreateScrapReturnDto,
  LossReportQuery,
  UpdateLossLimitsDto,
} from './dto/loss-report.dto';
import { LossReportsService } from './loss-reports.service';

/** Báo cáo hao hụt tuần — chỉ thủ kho, kế toán (và admin). QC không xem. */
@Controller('loss-reports')
@BlockWorker()
export class LossReportsController {
  constructor(private readonly reports: LossReportsService) {}

  @Get('weekly')
  @RequirePermissions(
    Permission.WAREHOUSE_KEEPER,
    Permission.ACCOUNTING_APPROVE,
  )
  weekly(@Query() query: LossReportQuery) {
    return this.reports.weekly(query);
  }

  @Get('limits')
  @RequirePermissions(
    Permission.WAREHOUSE_KEEPER,
    Permission.ACCOUNTING_APPROVE,
  )
  limits() {
    return this.reports.limits();
  }

  @Put('limits')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  updateLimits(
    @Body() dto: UpdateLossLimitsDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.reports.updateLimits(dto, user);
  }

  @Get('workers')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  workers() {
    return this.reports.workers();
  }

  /** Thủ kho nhận mạt vụn thợ trả cuối tuần. */
  @Post('scrap-returns')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  createScrapReturn(
    @Body() dto: CreateScrapReturnDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.reports.createScrapReturn(dto, user);
  }

  @Delete('scrap-returns/:id')
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  removeScrapReturn(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.removeScrapReturn(id);
  }
}
