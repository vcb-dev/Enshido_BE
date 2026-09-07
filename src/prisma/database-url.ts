/** Prisma URL for a long-running Nest process (session pooler, small pool). */
export function resolveDatabaseUrl(raw = process.env.DATABASE_URL): string {
  if (!raw) {
    throw new Error('DATABASE_URL is required');
  }

  const [base, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const host = base.match(/@([^/]+)/)?.[1] ?? '';
  const usesTransactionPooler = host.includes(':6543') || base.includes(':6543');

  if (usesTransactionPooler) {
    params.set('pgbouncer', 'true');
  } else {
    params.delete('pgbouncer');
  }
  if (!params.has('connection_limit')) {
    params.set('connection_limit', process.env.PRISMA_CONNECTION_LIMIT ?? '2');
  }
  if (!params.has('pool_timeout')) {
    params.set('pool_timeout', process.env.PRISMA_POOL_TIMEOUT ?? '20');
  }
  if (!params.has('connect_timeout')) {
    params.set('connect_timeout', '10');
  }

  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
