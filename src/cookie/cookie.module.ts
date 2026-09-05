import { Module } from '@nestjs/common';
import { CookieAuthService } from './cookie-auth.service';

@Module({
  providers: [CookieAuthService],
  exports: [CookieAuthService],
})
export class CookieModule {}
