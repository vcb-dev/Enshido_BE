import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { CastingSlipsController } from './casting-slips.controller';
import { CastingSlipsService } from './casting-slips.service';

@Module({
  imports: [UploadsModule],
  controllers: [CastingSlipsController],
  providers: [CastingSlipsService],
  exports: [CastingSlipsService],
})
export class CastingSlipsModule {}
