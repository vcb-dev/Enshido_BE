import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { prismaSchemaName, resolveDatabaseUrl } from './database-url';

const TX_MAX_WAIT_MS = 20_000;
const TX_TIMEOUT_MS = 30_000;
const TX_RETRIES = 3;

export const PRISMA_TX = {
  maxWait: TX_MAX_WAIT_MS,
  timeout: TX_TIMEOUT_MS,
} as const;

function isTxRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === 'P2028' || e.code === 'P2034' || e.code === 'P1017') return true;
  const msg = e.message ?? '';
  return (
    msg.includes('Transaction not found') ||
    msg.includes('expired transaction') ||
    msg.includes('Transaction already closed') ||
    msg.includes('Unable to start a transaction')
  );
}

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
      transactionOptions: PRISMA_TX,
    });
  }

  async onModuleInit() {
    // Connect lazily on the first query so a dead startup handshake
    // cannot occupy a pool slot for the life of the process.
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async runTx<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= TX_RETRIES; attempt++) {
      try {
        return await this.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('search_path', ${prismaSchemaName()}, true)`;
          return fn(tx);
        }, PRISMA_TX);
      } catch (err) {
        last = err;
        if (!isTxRetryable(err) || attempt === TX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 80 * attempt));
      }
    }
    throw last;
  }
}
