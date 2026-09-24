import { Controller, Get, Query } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { BlockWorker } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

class ListEditLogsQuery {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  entityType!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  entityId!: string;
}

@Controller('edit-logs')
export class EditLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @BlockWorker()
  list(@Query() query: ListEditLogsQuery) {
    return this.prisma.editLog.findMany({
      where: { entityType: query.entityType, entityId: query.entityId },
      orderBy: { changedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        reason: true,
        changedBy: true,
        changedAt: true,
      },
    });
  }
}
