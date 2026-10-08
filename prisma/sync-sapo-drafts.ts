import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PAGE_SIZE = 250;

type SapoLocation = {
  id: number;
  name: string;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  zip?: string | null;
  phone?: string | null;
  active?: boolean;
  created_on?: string | null;
  modified_on?: string | null;
};

type SapoImage = { id?: number; src?: string | null; variant_ids?: number[] };

type SapoVariant = {
  id: number;
  product_id?: number;
  title?: string | null;
  price?: string | number | null;
  sku?: string | null;
  barcode?: string | null;
  image_id?: number | null;
};

type SapoProduct = {
  id: number;
  name?: string | null;
  title?: string | null;
  image?: SapoImage | null;
  images?: SapoImage[] | null;
  variants?: SapoVariant[] | null;
};

type SapoInventoryLevel = {
  id: number;
  variant_id: number;
  store_id?: number | null;
  inventory_item_id: number;
  location_id: number;
  on_hand?: number | null;
  available?: number | null;
  packed?: number | null;
  committed?: number | null;
  incoming?: number | null;
  incoming_owned?: number | null;
  incoming_not_owned?: number | null;
  reserved?: number | null;
  unavailable?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type VariantInfo = {
  productId: number;
  productName: string;
  variantTitle: string | null;
  imageSrc: string | null;
  price: string;
  sku: string | null;
  barcode: string | null;
};

function requireSapoEnv() {
  const storeRaw = process.env.SAPO_STORE?.trim() ?? '';
  const apiKey = process.env.SAPO_API_KEY?.trim() ?? '';
  const apiSecret = process.env.SAPO_API_SECRET?.trim() ?? '';
  const accessToken = process.env.SAPO_ACCESS_TOKEN?.trim() ?? '';
  if (!storeRaw) {
    throw new Error(
      'Thiếu SAPO_STORE trong .env (vd. ten-shop hoặc ten-shop.mysapo.net).',
    );
  }
  if (!accessToken && (!apiKey || !apiSecret)) {
    throw new Error(
      'Thiếu SAPO_API_KEY + SAPO_API_SECRET (Private App) hoặc SAPO_ACCESS_TOKEN.',
    );
  }
  const host = storeRaw
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.mysapo\.net$/i, '');
  return {
    baseUrl: `https://${host}.mysapo.net/admin`,
    apiKey,
    apiSecret,
    accessToken,
  };
}

function authHeaders(env: ReturnType<typeof requireSapoEnv>) {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) EnshidoSapoSync/1.0',
  };
  if (env.accessToken) {
    headers['X-Sapo-Access-Token'] = env.accessToken;
    return headers;
  }
  headers.Authorization = `Basic ${Buffer.from(`${env.apiKey}:${env.apiSecret}`).toString('base64')}`;
  return headers;
}

async function sapoGet<T>(
  env: ReturnType<typeof requireSapoEnv>,
  path: string,
  query: Record<string, string | number>,
): Promise<T> {
  const url = new URL(`${env.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(url, {
      headers: authHeaders(env),
      signal: AbortSignal.timeout(45_000),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Sapo ${res.status} ${path}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }
  throw new Error(`Sapo rate-limit ${path}`);
}

async function fetchAllPages<T extends { id: number }>(
  env: ReturnType<typeof requireSapoEnv>,
  path: string,
  key: string,
  extra: Record<string, string | number> = {},
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= 500; page += 1) {
    const json = await sapoGet<Record<string, T[]>>(env, path, {
      page,
      limit: PAGE_SIZE,
      ...extra,
    });
    const batch = json[key] ?? [];
    const fresh = batch.filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
    rows.push(...fresh);
    console.log(`${path} trang ${page} +${fresh.length} (tổng ${rows.length})`);
    if (batch.length < PAGE_SIZE || fresh.length < PAGE_SIZE) break;
  }
  return rows;
}

function asDate(value?: string | null) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function asQty(value?: number | null) {
  return value ?? 0;
}

function imageForVariant(product: SapoProduct, variant: SapoVariant) {
  const images = product.images ?? [];
  if (variant.image_id) {
    const match = images.find((img) => img.id === variant.image_id);
    if (match?.src) return match.src;
  }
  const byVariant = images.find((img) => img.variant_ids?.includes(variant.id));
  if (byVariant?.src) return byVariant.src;
  return product.image?.src ?? images[0]?.src ?? null;
}

async function main() {
  const env = requireSapoEnv();
  const now = new Date();
  console.log(`Kéo Sapo ${env.baseUrl} …`);

  const locations = await fetchAllPages<SapoLocation>(
    env,
    '/locations.json',
    'locations',
  );
  if (!locations.length) {
    throw new Error('Sapo không trả location nào từ GET /admin/locations.json');
  }

  for (const loc of locations) {
    const data = {
      name: loc.name,
      address1: loc.address1 ?? null,
      address2: loc.address2 ?? null,
      city: loc.city ?? null,
      province: loc.province ?? null,
      country: loc.country ?? null,
      zip: loc.zip ?? null,
      phone: loc.phone ?? null,
      active: loc.active ?? true,
      sapoCreatedOn: asDate(loc.created_on),
      sapoModifiedOn: asDate(loc.modified_on),
      syncedAt: now,
    };
    await prisma.locationDraft.upsert({
      where: { sapoId: BigInt(loc.id) },
      create: { id: randomUUID(), sapoId: BigInt(loc.id), ...data },
      update: data,
    });
  }

  const products = await fetchAllPages<SapoProduct>(
    env,
    '/products.json',
    'products',
    { fields: 'id,name,title,image,images,variants' },
  );
  const variants = new Map<number, VariantInfo>();
  for (const product of products) {
    const productName = product.name || product.title || '';
    for (const variant of product.variants ?? []) {
      variants.set(variant.id, {
        productId: product.id,
        productName,
        variantTitle: variant.title ?? null,
        imageSrc: imageForVariant(product, variant),
        price: String(variant.price ?? 0),
        sku: variant.sku || null,
        barcode: variant.barcode || null,
      });
    }
  }

  const levels: SapoInventoryLevel[] = [];
  for (const loc of locations) {
    console.log(`Tồn kho location ${loc.id} ${loc.name}`);
    const batch = await fetchAllPages<SapoInventoryLevel>(
      env,
      '/inventory_levels.json',
      'inventory_levels',
      { location_ids: loc.id },
    );
    levels.push(...batch);
  }

  const locationIds = new Set(locations.map((loc) => loc.id));
  let skipped = 0;
  const rows = [];
  for (const level of levels) {
    if (!locationIds.has(level.location_id)) {
      skipped += 1;
      continue;
    }
    const info = variants.get(level.variant_id);
    rows.push({
      id: randomUUID(),
      sapoId: BigInt(level.id),
      sapoVariantId: BigInt(level.variant_id),
      sapoInventoryItemId: BigInt(level.inventory_item_id),
      sapoLocationId: BigInt(level.location_id),
      sapoStoreId:
        level.store_id == null ? null : BigInt(level.store_id),
      sapoProductId:
        info?.productId == null ? null : BigInt(info.productId),
      productName: info?.productName ?? null,
      variantTitle: info?.variantTitle ?? null,
      imageSrc: info?.imageSrc ?? null,
      price: info?.price ?? 0,
      sku: info?.sku ?? null,
      barcode: info?.barcode ?? null,
      onHand: asQty(level.on_hand),
      packed: asQty(level.packed),
      available: asQty(level.available),
      committed: asQty(level.committed),
      incoming: asQty(level.incoming),
      incomingOwned: asQty(level.incoming_owned),
      incomingNotOwned: asQty(level.incoming_not_owned),
      reserved: asQty(level.reserved),
      unavailable: asQty(level.unavailable),
      sapoCreatedAt: asDate(level.created_at),
      sapoUpdatedAt: asDate(level.updated_at),
      syncedAt: now,
    });
  }

  await prisma.inventoryDraft.deleteMany();
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await prisma.inventoryDraft.createMany({ data: chunk });
    console.log(`inventory_draft +${chunk.length} (tổng ${Math.min(i + CHUNK, rows.length)}/${rows.length})`);
  }

  const [locationCount, inventoryCount] = await Promise.all([
    prisma.locationDraft.count(),
    prisma.inventoryDraft.count(),
  ]);
  console.log(
    `Đã kéo ${locations.length} location → location_draft (${locationCount} dòng).`,
  );
  console.log(
    `Đã kéo ${levels.length} tồn kho (${products.length} SP) → inventory_draft (${inventoryCount} dòng).`,
  );
  if (skipped) {
    console.log(`Bỏ ${skipped} dòng inventory_levels vì location_id không có trong location_draft.`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
