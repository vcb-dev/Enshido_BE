import { Module } from '@nestjs/common';
import { EditLogsController } from './edit-logs.controller';

@Module({
  controllers: [EditLogsController],
})
export class EditLogsModule {}
