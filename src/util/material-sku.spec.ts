import { Prisma } from '@prisma/client';
import {
  allocateMaterialSku,
  formatMaterialSku,
  skuPrefixOf,
} from './material-sku';

describe('skuPrefixOf', () => {
  it('gắn chữ cái theo loại kho', () => {
    expect(skuPrefixOf('nvl-chinh')).toBe('A');
    expect(skuPrefixOf('btp-cho-vao-da')).toBe('B');
    expect(skuPrefixOf('thanh-pham')).toBe('C');
    expect(skuPrefixOf('nvl-tieu-hao')).toBe('D');
  });
});

describe('formatMaterialSku', () => {
  it('chữ cái + đúng 5 số, có số 0 phía trước', () => {
    expect(formatMaterialSku('A', 5)).toBe('A00005');
    expect(formatMaterialSku('B', 22225)).toBe('B22225');
    expect(formatMaterialSku('C', 66662)).toBe('C66662');
    expect(formatMaterialSku('D', 88881)).toBe('D88881');
  });
});

describe('allocateMaterialSku', () => {
  it('lấy max của đúng tiền tố rồi + 1', async () => {
    const seen: Prisma.Sql[] = [];
    const db = {
      $queryRaw: async <T>(query: Prisma.Sql) => {
        seen.push(query);
        return [{ max: 5 }] as T;
      },
    };
    await expect(allocateMaterialSku(db, 'nvl-chinh')).resolves.toBe('A00006');
    await expect(allocateMaterialSku(db, 'btp-cho-vao-da')).resolves.toBe(
      'B00006',
    );
    expect(String(seen[0].values[0])).toContain('^A[0-9]');
    expect(String(seen[1].values[0])).toContain('^B[0-9]');
  });

  it('kho trống bắt đầu từ 00001', async () => {
    const db = {
      $queryRaw: async <T>() => [{ max: null }] as T,
    };
    await expect(allocateMaterialSku(db, 'nvl-tieu-hao')).resolves.toBe(
      'D00001',
    );
  });
});
