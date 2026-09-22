import { dbTable, prismaSchemaName, resolveDatabaseUrl } from './database-url';

describe('prismaSchemaName', () => {
  it('lấy schema từ query string', () => {
    expect(
      prismaSchemaName(
        'postgresql://u:p@h:5432/postgres?schema=enshido&sslmode=require',
      ),
    ).toBe('enshido');
  });

  it('không có schema thì public', () => {
    expect(prismaSchemaName('postgresql://u:p@h:5432/postgres')).toBe('public');
  });
});

describe('dbTable', () => {
  it('ghép schema.table để raw SQL không tìm nhầm public', () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      'postgresql://u:p@h:5432/postgres?schema=enshido';
    try {
      const sql = dbTable('stock_balances') as { strings?: string[] };
      expect(sql.strings?.join('') ?? JSON.stringify(sql)).toContain(
        '"enshido"."stock_balances"',
      );
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});

describe('resolveDatabaseUrl', () => {
  it('gắn search_path khi URL có schema, để raw SQL cùng chỗ với Prisma Client', () => {
    const url = resolveDatabaseUrl(
      'postgresql://u:p@h:5432/postgres?schema=enshido',
    );
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('schema')).toBe('enshido');
    expect(params.get('options')).toBe('-csearch_path=enshido');
  });
});
