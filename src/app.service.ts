import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getInfo() {
    return {
      service: 'Enshido_BE',
      version: '0.0.1',
    };
  }

  getHealth() {
    return {
      status: 'ok',
      service: 'Enshido_BE',
      timestamp: new Date().toISOString(),
    };
  }
}
