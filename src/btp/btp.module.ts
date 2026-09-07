import { Module } from '@nestjs/common';
import { BtpController } from './btp.controller';
import { BtpService } from './btp.service';

@Module({
  controllers: [BtpController],
  providers: [BtpService],
})
export class BtpModule {}
