import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { IntakeOrdersController } from './intake-orders.controller';
import { IntakeOrdersService } from './intake-orders.service';

@Module({
  imports: [UploadsModule],
  controllers: [IntakeOrdersController],
  providers: [IntakeOrdersService],
})
export class IntakeOrdersModule {}
