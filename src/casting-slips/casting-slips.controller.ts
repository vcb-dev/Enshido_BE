import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  BlockWorker,
  CurrentUser,
  RequirePermissions,
} from '../auth/decorators';
import { Permission } from '../auth/permissions';
import type { AuthUserPayload } from '../auth/types';
import { CastingSlipsService } from './casting-slips.service';
import {
  CastingLossQuery,
  ConfirmCastingSlipDto,
  CastingSlipCandidatesQuery,
  CastingSlipResultDto,
  CreateCastingSlipDto,
  IssueCastingSlipDto,
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

  /** Đơn đã có sáp chờ gom vào phiếu đúc. Đặt trước `:id` để không bị bắt nhầm route. */
  /** Hao hụt đúc theo thợ đúc (phiếu đã xác nhận Đúc xong). */
  @Get('loss-by-worker')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  lossByWorker(@Query() query: CastingLossQuery) {
    return this.slips.lossByWorker(query);
  }

  @Get('candidates')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  candidates(@Query() query: CastingSlipCandidatesQuery) {
    return this.slips.candidates(query);
  }

  @Get('cast-workers')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  listCastWorkers() {
    return this.slips.listCastWorkers();
  }

  /** Mở phiếu từ QR in trên phiếu giấy. */
  /** Mã NVL (gram, kho NVL chính) nhận phần cây còn lại lúc xác nhận đúc. */
  @Get('rest-material-options')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  restMaterialOptions() {
    return this.slips.restMaterialOptions();
  }

  @Get('by-code/:code')
  @BlockWorker()
  byCode(@Param('code') code: string) {
    return this.slips.getByCode(code);
  }

  @Get(':id')
  @BlockWorker()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.slips.getById(id);
  }

  /** Bước 7: thủ kho lên một phiếu cho một lần đúc nhiều đơn. */
  @Post()
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  create(
    @Body() dto: CreateCastingSlipDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.slips.create(dto, user);
  }

  /** Bước 7b: chụp ảnh phiếu + vật tư đã cấp, Lưu → đơn Chờ đúc. */
  @Post(':id/issue')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueCastingSlipDto,
  ) {
    return this.slips.issue(id, dto);
  }

  @Delete(':id')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.slips.remove(id);
  }

  @Post(':id/printed')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  markPrinted(@Param('id', ParseUUIDPipe) id: string) {
    return this.slips.markPrinted(id);
  }

  /** Bước 8: thợ đúc quét phiếu và nguyên liệu → Đang đúc (G). */
  @Post(':id/start')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_CAST)
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.slips.start(id, user);
  }

  /** Bước 9: thợ đúc nhập kết quả sau đúc, chờ thủ kho xác nhận. */
  @Post(':id/result')
  @BlockWorker()
  @RequirePermissions(Permission.PRODUCTION_CAST)
  submitResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CastingSlipResultDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.slips.submitResult(id, dto, user);
  }

  /** Thủ kho cắt cây thông: chia phôi vào lệnh sản xuất và chuyển sang Nguội. */
  @Post(':id/confirm')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmCastingSlipDto,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.slips.confirm(id, dto, user);
  }

  /** Thủ kho báo lỗi đúc → phiếu mới Chờ đúc, thợ làm lại. */
  @Post(':id/reject-cast')
  @BlockWorker()
  @RequirePermissions(Permission.WAREHOUSE_KEEPER)
  rejectCast(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.slips.rejectCastResult(id, user);
  }
}
