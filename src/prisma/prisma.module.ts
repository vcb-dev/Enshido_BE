import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaService };

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: () => {
        globalForPrisma.prisma ??= new PrismaService();
        return globalForPrisma.prisma;
      },
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
