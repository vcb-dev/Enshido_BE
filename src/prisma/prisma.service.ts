import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from './database-url';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      log: ['error'],
      datasources: {
        db: { url: resolveDatabaseUrl() },
      },
    });
  }

  async onModuleInit() {
    // Connect lazily on the first query so a dead startup handshake
    // cannot occupy a pool slot for the life of the process.
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
