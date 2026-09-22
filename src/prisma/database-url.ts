import { Prisma } from '@prisma/client';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Schema trong DATABASE_URL (?schema=enshido). Prisma Client dùng, raw SQL thì không. */
export function prismaSchemaName(raw = process.env.DATABASE_URL): string {
  if (!raw) return 'public';
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const schema = new URLSearchParams(query).get('schema')?.trim();
  return schema && IDENT.test(schema) ? schema : 'public';
}

/** `"enshido"."stock_balances"` — raw SQL không ăn `?schema=` của Prisma. */
export function dbTable(name: string): Prisma.Sql {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid table name: ${name}`);
  }
  const schema = prismaSchemaName();
  return Prisma.raw(`"${schema}"."${name}"`);
}

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
    params.set('connection_limit', process.env.PRISMA_CONNECTION_LIMIT ?? '10');
  }
  if (!params.has('pool_timeout')) {
    params.set('pool_timeout', process.env.PRISMA_POOL_TIMEOUT ?? '20');
  }
  if (!params.has('connect_timeout')) {
    params.set('connect_timeout', '10');
  }
  // Prisma `schema=` chỉ gắn vào query do Client sinh. Raw SQL nhìn search_path
  // (thường là public) — thiếu options thì lên đơn BTP chết vì không thấy stock_balances.
  const schema = params.get('schema');
  if (schema && IDENT.test(schema) && !params.has('options')) {
    params.set('options', `-csearch_path=${schema}`);
  }

  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
