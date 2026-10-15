/**
 * Tách bạch độ trễ tới database: bắt tay TCP (mạng thuần) so với một truy vấn thật,
 * và pooler giao dịch (6543) so với kết nối trực tiếp (5432).
 * Chạy: npx ts-node prisma/measure-latency.ts
 */
import { connect } from 'node:net';
import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from '../src/prisma/database-url';

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
  };
}

function show(label: string, values: number[]) {
  const s = stats(values);
  console.log(
    `${label.padEnd(38)} min ${s.min.toFixed(0).padStart(4)} ms · p50 ${s.p50.toFixed(0).padStart(4)} ms · p90 ${s.p90.toFixed(0).padStart(4)} ms`,
  );
}

/** Thời gian bắt tay TCP — độ trễ mạng thuần, chưa có database tham gia. */
function tcpHandshake(host: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = connect({ host, port }, () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      socket.destroy();
      resolve(ms);
    });
    socket.setTimeout(10_000);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('TCP timeout'));
    });
    socket.on('error', reject);
  });
}

async function queryLatency(url: string, rounds: number) {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    for (let i = 0; i < 8; i++) await prisma.$queryRaw`SELECT 1`;
    const runs: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const started = process.hrtime.bigint();
      await prisma.$queryRaw`SELECT 1`;
      runs.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return runs;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const base = resolveDatabaseUrl();
  const host = base.replace(/^.*@/, '').replace(/[:/].*$/, '');
  const on = (port: number) => base.replace(/:(6543|5432)\//, `:${port}/`);

  console.log(`Host: ${host}\n`);

  const handshakes: number[] = [];
  for (let i = 0; i < 10; i++) handshakes.push(await tcpHandshake(host, 5432));
  show('Bắt tay TCP (mạng thuần)', handshakes);

  // Đo xen kẽ hai cổng nhiều vòng: mạng tới Singapore chập chờn nên đo liền một mạch
  // từng cổng dễ bị một cơn nghẽn làm lệch kết quả.
  const byPort: Record<number, number[]> = { 6543: [], 5432: [] };
  for (let round = 0; round < 3; round++) {
    for (const port of [6543, 5432] as const) {
      byPort[port].push(...(await queryLatency(on(port), 12)));
    }
  }
  show('SELECT 1 qua pooler giao dịch 6543', byPort[6543]);
  show('SELECT 1 qua pooler phiên 5432', byPort[5432]);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
