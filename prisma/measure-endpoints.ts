/**
 * Đo thời gian các endpoint danh sách nặng nhất qua HTTP, chạy với server dev đang bật.
 * Dùng để so trước / sau khi đổi cách đọc quan hệ. Chạy: npx ts-node prisma/measure-endpoints.ts
 */
const BASE = process.env.API_BASE ?? 'http://localhost:3000/api';
// Truyền qua biến môi trường: MEASURE_USERNAME=... MEASURE_PASSWORD=... npx ts-node ...
const USERNAME = process.env.MEASURE_USERNAME;
const PASSWORD = process.env.MEASURE_PASSWORD;

const PATHS = [
  '/production-orders?page=1&pageSize=25',
  '/intake-orders/pipeline-lists?rootsOnly=true&pageSize=120',
  '/production-orders/my-tickets',
  '/production-orders/qc-tickets',
  '/casting-slips?page=1&pageSize=25',
  '/finished-goods/stock',
  '/finished-goods/receipts',
];

const ROUNDS = 3;

async function login() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('Cần MEASURE_USERNAME và MEASURE_PASSWORD trong môi trường');
  }
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Đăng nhập hỏng: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie?.() ?? [];
  return cookie.map((item) => item.split(';')[0]).join('; ');
}

async function time(path: string, cookie: string) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
  const body = await res.text();
  return { ms: Date.now() - started, status: res.status, bytes: body.length };
}

async function main() {
  const cookie = await login();
  for (const path of PATHS) {
    const runs: number[] = [];
    let status = 0;
    let bytes = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const result = await time(path, cookie);
      runs.push(result.ms);
      status = result.status;
      bytes = result.bytes;
    }
    const best = Math.min(...runs);
    const median = [...runs].sort((a, b) => a - b)[Math.floor(ROUNDS / 2)];
    console.log(
      `${path.padEnd(58)} ${String(status)} · nhanh nhất ${String(best).padStart(5)} ms · giữa ${String(median).padStart(5)} ms · ${(bytes / 1024).toFixed(0)} KB`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
