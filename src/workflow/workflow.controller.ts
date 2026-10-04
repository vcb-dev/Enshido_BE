import { Controller, Get } from '@nestjs/common';
import { BlockWorker } from '../auth/decorators';
import { WorkflowService } from './workflow.service';

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  /** Mọi role (kể cả thợ) — poll revision để Phiếu của tôi / lệnh SX cập nhật không F5. */
  @Get('revision')
  revision() {
    return this.workflow.revision();
  }

  @Get('intake-live')
  @BlockWorker()
  intakeLive() {
    return this.workflow.intakeLive();
  }
}
