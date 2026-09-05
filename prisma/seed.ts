import { MaterialClass, PrismaClient, RoleCode } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'Admin@123';
const BCRYPT_COST = 8;

async function seedUsers() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  const users = [
    {
      username: 'admin',
      fullName: 'Admin Enshido',
      roleCode: RoleCode.ADMIN,
      extraRoles: [] as RoleCode[],
      department: 'IT',
    },
    {
      username: 'user',
      fullName: 'User Enshido',
      roleCode: RoleCode.USER,
      extraRoles: [] as RoleCode[],
      department: 'Operations',
    },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { username: u.username },
      update: {
        passwordHash,
        fullName: u.fullName,
        roleCode: u.roleCode,
        extraRoles: u.extraRoles,
        department: u.department,
        isActive: true,
      },
      create: {
        username: u.username,
        passwordHash,
        fullName: u.fullName,
        roleCode: u.roleCode,
        extraRoles: u.extraRoles,
        department: u.department,
        isActive: true,
      },
    });
  }
}

async function seedLookups() {
  for (const row of [
    { code: 'vien', name: 'viên', sortOrder: 1 },
    { code: 'ct', name: 'ct', sortOrder: 2 },
    { code: 'bang', name: 'bảng', sortOrder: 3 },
    { code: 'bo', name: 'bộ', sortOrder: 4 },
    { code: 'gram', name: 'gram', sortOrder: 5 },
    { code: 'met', name: 'mét', sortOrder: 6 },
    { code: 'chai', name: 'chai', sortOrder: 7 },
    { code: 'to', name: 'tờ', sortOrder: 8 },
    { code: 'thoi', name: 'thỏi', sortOrder: 9 },
  ]) {
    await prisma.unit.upsert({
      where: { code: row.code },
      update: { name: row.name, sortOrder: row.sortOrder },
      create: row,
    });
  }

  for (const row of [
    { code: 'da-moiss', name: 'Đá Moiss', sortOrder: 1 },
    { code: 'da-cz', name: 'Đá CZ', sortOrder: 2 },
    { code: 'da-quy-khac', name: 'Đá quý khác', sortOrder: 3 },
    { code: 'da-thuong', name: 'Đá thường', sortOrder: 4 },
  ]) {
    await prisma.materialType.upsert({
      where: { code: row.code },
      update: { name: row.name, sortOrder: row.sortOrder },
      create: row,
    });
  }

  for (const row of [
    { code: 'tron', name: 'Tròn', sortOrder: 1 },
    { code: 'chu-nhat', name: 'Hình chữ nhật', sortOrder: 2 },
    { code: 'oval', name: 'Oval', sortOrder: 3 },
    { code: 'hat-thoc', name: 'Hạt thóc', sortOrder: 4 },
    { code: 'trai-tim', name: 'Trái tim', sortOrder: 5 },
    { code: 'vuong', name: 'Vuông', sortOrder: 6 },
    { code: 'hoa-5-canh', name: 'Hoa 5 cánh', sortOrder: 7 },
    { code: 'giot-nuoc', name: 'Giọt nước', sortOrder: 8 },
    { code: 'hinh-thang', name: 'Hình thang', sortOrder: 9 },
    { code: 'tam-giac', name: 'Tam giác', sortOrder: 10 },
    { code: 'sao', name: 'Sao', sortOrder: 11 },
  ]) {
    await prisma.shape.upsert({
      where: { code: row.code },
      update: { name: row.name, sortOrder: row.sortOrder },
      create: row,
    });
  }

  for (const row of [
    { code: 'trang', name: 'Trắng', skuLetter: 'W', sortOrder: 1 },
    { code: 'trang-nga', name: 'Trắng ngà', skuLetter: 'W', sortOrder: 2 },
    { code: 'xam', name: 'Xám', skuLetter: 'G', sortOrder: 3 },
    { code: 'den', name: 'Đen', skuLetter: 'K', sortOrder: 4 },
    { code: 'vang', name: 'Vàng', skuLetter: 'Y', sortOrder: 5 },
    { code: 'vang-nhat', name: 'Vàng nhạt', skuLetter: 'Y', sortOrder: 6 },
    { code: 'champagne', name: 'Champagne', skuLetter: 'Y', sortOrder: 7 },
    { code: 'cam', name: 'Cam', skuLetter: 'O', sortOrder: 8 },
    { code: 'cam-dam', name: 'Cam đậm', skuLetter: 'O', sortOrder: 9 },
    { code: 'nau', name: 'Nâu', skuLetter: 'N', sortOrder: 10 },
    { code: 'do', name: 'Đỏ', skuLetter: 'R', sortOrder: 11 },
    { code: 'do-dam', name: 'Đỏ đậm', skuLetter: 'R', sortOrder: 12 },
    { code: 'hong', name: 'Hồng', skuLetter: 'P', sortOrder: 13 },
    { code: 'hong-nhat', name: 'Hồng nhạt', skuLetter: 'P', sortOrder: 14 },
    { code: 'hong-dam', name: 'Hồng đậm', skuLetter: 'P', sortOrder: 15 },
    { code: 'tim', name: 'Tím', skuLetter: 'V', sortOrder: 16 },
    { code: 'tim-dam', name: 'Tím đậm', skuLetter: 'V', sortOrder: 17 },
    { code: 'xanh-duong', name: 'Xanh dương', skuLetter: 'B', sortOrder: 18 },
    { code: 'xanh-duong-nhat', name: 'Xanh dương nhạt', skuLetter: 'L', sortOrder: 19 },
    { code: 'xanh-duong-dam', name: 'Xanh dương đậm', skuLetter: 'B', sortOrder: 20 },
    { code: 'xanh-ngoc', name: 'Xanh ngọc', skuLetter: 'C', sortOrder: 21 },
    { code: 'xanh-la', name: 'Xanh lá', skuLetter: 'G', sortOrder: 22 },
    { code: 'xanh-la-nhat', name: 'Xanh lá nhạt', skuLetter: 'G', sortOrder: 23 },
    { code: 'teal', name: 'Xanh teal', skuLetter: 'T', sortOrder: 24 },
    { code: 'lime', name: 'Xanh chanh', skuLetter: 'L', sortOrder: 25 },
    { code: 'xanh-xam', name: 'Xanh xám', skuLetter: 'S', sortOrder: 26 },
  ]) {
    await prisma.color.upsert({
      where: { code: row.code },
      update: {
        name: row.name,
        skuLetter: row.skuLetter,
        sortOrder: row.sortOrder,
      },
      create: row,
    });
  }

  for (const row of [
    { code: 'hongkong', name: 'Hongkong', sortOrder: 1 },
    { code: 'hagems', name: 'Hagems', sortOrder: 2 },
  ]) {
    await prisma.supplier.upsert({
      where: { code: row.code },
      update: { name: row.name, sortOrder: row.sortOrder },
      create: row,
    });
  }
}

async function seedWarehouses() {
  const nvlChinh = await prisma.warehouse.upsert({
    where: { code: 'nvl-chinh' },
    update: {
      name: 'Kho nguyên vật liệu chính',
      shortName: 'Kho NVL chính',
      description: 'Gồm kho bạc (kèm BTP chờ vào đá) và kho đá.',
      sortOrder: 1,
      isActive: true,
    },
    create: {
      code: 'nvl-chinh',
      name: 'Kho nguyên vật liệu chính',
      shortName: 'Kho NVL chính',
      description: 'Gồm kho bạc (kèm BTP chờ vào đá) và kho đá.',
      sortOrder: 1,
    },
  });

  for (const child of [
    {
      code: 'bac',
      name: 'Kho bạc',
      shortName: 'Kho bạc',
      description: 'Nguyên liệu bạc.',
      sortOrder: 1,
    },
    {
      code: 'da',
      name: 'Kho đá',
      shortName: 'Kho đá',
      description: 'Tồn kho NVL đá xưởng.',
      sortOrder: 2,
    },
  ]) {
    await prisma.warehouse.upsert({
      where: { code: child.code },
      update: { ...child, parentId: nvlChinh.id, isActive: true },
      create: { ...child, parentId: nvlChinh.id },
    });
  }

  await prisma.warehouse.upsert({
    where: { code: 'nvl-tieu-hao' },
    update: {
      name: 'Kho nguyên vật liệu tiêu hao',
      shortName: 'Kho NVL tiêu hao',
      description: 'Vật tư tiêu hao phục vụ sản xuất.',
      sortOrder: 2,
      isActive: true,
    },
    create: {
      code: 'nvl-tieu-hao',
      name: 'Kho nguyên vật liệu tiêu hao',
      shortName: 'Kho NVL tiêu hao',
      description: 'Vật tư tiêu hao phục vụ sản xuất.',
      sortOrder: 2,
    },
  });

  const bac = await mustCode(
    await prisma.warehouse.findUnique({ where: { code: 'bac' } }),
    'kho bac',
  );

  await prisma.warehouse.upsert({
    where: { code: 'ban-thanh-pham' },
    update: {
      name: 'Kho bán thành phẩm chờ vào đá',
      shortName: 'Kho BTP chờ vào đá',
      description: 'Bán thành phẩm đã gia công, chờ gắn đá.',
      sortOrder: 3,
      parentId: bac.id,
      isActive: true,
    },
    create: {
      code: 'ban-thanh-pham',
      name: 'Kho bán thành phẩm chờ vào đá',
      shortName: 'Kho BTP chờ vào đá',
      description: 'Bán thành phẩm đã gia công, chờ gắn đá.',
      sortOrder: 3,
      parentId: bac.id,
    },
  });
}

async function mustCode<T extends { id: string }>(
  row: T | null,
  label: string,
): Promise<T> {
  if (!row) throw new Error(`Thiếu danh mục: ${label}`);
  return row;
}

async function seedDaStock() {
  const warehouse = await mustCode(
    await prisma.warehouse.findUnique({ where: { code: 'da' } }),
    'kho da',
  );

  const unit = {
    vien: (await mustCode(await prisma.unit.findUnique({ where: { code: 'vien' } }), 'vien')).id,
    ct: (await mustCode(await prisma.unit.findUnique({ where: { code: 'ct' } }), 'ct')).id,
  };
  const type = {
    moiss: (await mustCode(await prisma.materialType.findUnique({ where: { code: 'da-moiss' } }), 'da-moiss')).id,
    quy: (await mustCode(await prisma.materialType.findUnique({ where: { code: 'da-quy-khac' } }), 'da-quy-khac')).id,
    cz: (await mustCode(await prisma.materialType.findUnique({ where: { code: 'da-cz' } }), 'da-cz')).id,
  };
  const shape = {
    tron: (await mustCode(await prisma.shape.findUnique({ where: { code: 'tron' } }), 'tron')).id,
    hatThoc: (await mustCode(await prisma.shape.findUnique({ where: { code: 'hat-thoc' } }), 'hat-thoc')).id,
    traiTim: (await mustCode(await prisma.shape.findUnique({ where: { code: 'trai-tim' } }), 'trai-tim')).id,
    chuNhat: (await mustCode(await prisma.shape.findUnique({ where: { code: 'chu-nhat' } }), 'chu-nhat')).id,
  };
  const color = {
    trang: (await mustCode(await prisma.color.findUnique({ where: { code: 'trang' } }), 'trang')).id,
    xanhDuong: (await mustCode(await prisma.color.findUnique({ where: { code: 'xanh-duong' } }), 'xanh-duong')).id,
    do: (await mustCode(await prisma.color.findUnique({ where: { code: 'do' } }), 'do')).id,
    hongNhat: (await mustCode(await prisma.color.findUnique({ where: { code: 'hong-nhat' } }), 'hong-nhat')).id,
    hong: (await mustCode(await prisma.color.findUnique({ where: { code: 'hong' } }), 'hong')).id,
  };

  const samples = [
    {
      sku: 'MROW0.8',
      name: 'Đá Moiss Round tròn trắng 0.8 mm',
      locationCode: '1A1',
      unitId: unit.ct,
      materialTypeId: type.moiss,
      shapeId: shape.tron,
      colorId: color.trang,
      sizeLabel: '0.8 mm',
      sortOrder: 1,
      openingQty: '80',
      openingAmount: '40000',
      inQty: '0',
      inAmount: '0',
      outQty: '5',
      outAmount: '0',
      qty: '75',
      amount: '40000',
    },
    {
      sku: 'MROW0.9',
      name: 'Đá Moiss Round tròn trắng 0.9 mm',
      locationCode: '1A2',
      unitId: unit.ct,
      materialTypeId: type.moiss,
      shapeId: shape.tron,
      colorId: color.trang,
      sizeLabel: '0.9 mm',
      sortOrder: 2,
      openingQty: '92.86',
      openingAmount: '65002',
      inQty: '116.5',
      inAmount: '9817500',
      outQty: '198.36',
      outAmount: '7000',
      qty: '11',
      amount: '9875502',
    },
    {
      sku: 'MROW1.0',
      name: 'Đá Moiss Round tròn trắng 1.0 mm',
      locationCode: '1A3',
      unitId: unit.ct,
      materialTypeId: type.moiss,
      shapeId: shape.tron,
      colorId: color.trang,
      sizeLabel: '1.0 mm',
      sortOrder: 3,
      openingQty: '85',
      openingAmount: '63750',
      inQty: '84',
      inAmount: '6468000',
      outQty: '140',
      outAmount: '37500',
      qty: '29',
      amount: '6494250',
    },
    {
      sku: 'MROB1.0',
      name: 'Đá Moiss Round tròn xanh dương đậm 1.0 mm',
      locationCode: '1A3',
      unitId: unit.ct,
      materialTypeId: type.moiss,
      shapeId: shape.tron,
      colorId: color.xanhDuong,
      sizeLabel: '1.0 mm',
      sortOrder: 4,
      openingQty: '0',
      openingAmount: '0',
      inQty: '600',
      inAmount: '1214400',
      outQty: '600',
      outAmount: '0',
      qty: '0',
      amount: '1214400',
    },
    {
      sku: 'MROR1.0',
      name: 'Đá Moiss Round tròn đỏ ganet 1 mm',
      locationCode: '1A3',
      unitId: unit.ct,
      materialTypeId: type.moiss,
      shapeId: shape.tron,
      colorId: color.do,
      sizeLabel: '1 mm',
      sortOrder: 5,
      openingQty: '0',
      openingAmount: '0',
      inQty: '3.5',
      inAmount: '38400',
      outQty: '2',
      outAmount: '0',
      qty: '1.5',
      amount: '38400',
    },
    {
      sku: 'MROW4.0',
      name: 'Đá Moiss Round tròn trắng 4.0 mm DT GRA',
      locationCode: '1E5',
      unitId: unit.vien,
      materialTypeId: type.moiss,
      shapeId: shape.tron,
      colorId: color.trang,
      sizeLabel: '4.0 mm',
      quality: 'DT GRA',
      sortOrder: 6,
      openingQty: '316',
      openingAmount: '8532000',
      inQty: '2018',
      inAmount: '46162800',
      outQty: '2052',
      outAmount: '34891800',
      qty: '282',
      amount: '19803000',
    },
    {
      sku: 'MMAW10*5',
      name: 'Đá Moiss hình hạt thóc màu trắng kt 10 x 5',
      locationCode: null,
      unitId: unit.vien,
      materialTypeId: type.moiss,
      shapeId: shape.hatThoc,
      colorId: color.trang,
      sizeLabel: '10 x 5',
      sortOrder: 7,
      openingQty: '63',
      openingAmount: '6099345',
      inQty: '0',
      inAmount: '0',
      outQty: '11',
      outAmount: '290445',
      qty: '52',
      amount: '5808900',
    },
    {
      sku: 'MHEW3*3',
      name: 'Đá Mois Heart D trái tim trắng 3.0x3.0',
      locationCode: null,
      unitId: unit.vien,
      materialTypeId: type.moiss,
      shapeId: shape.traiTim,
      colorId: color.trang,
      sizeLabel: '3.0x3.0',
      sortOrder: 8,
      openingQty: '1',
      openingAmount: '8900',
      inQty: '0',
      inAmount: '0',
      outQty: '0',
      outAmount: '0',
      qty: '1',
      amount: '8900',
    },
    {
      sku: 'SAP-PNK-1.2',
      name: 'Đá Sa Phia tròn màu hồng nhạt 1.2',
      locationCode: null,
      unitId: unit.vien,
      materialTypeId: type.quy,
      shapeId: shape.tron,
      colorId: color.hongNhat,
      sizeLabel: '1.2',
      sortOrder: 9,
      openingQty: '523',
      openingAmount: '135980',
      inQty: '1000',
      inAmount: '765000',
      outQty: '0',
      outAmount: '0',
      qty: '1523',
      amount: '900980',
    },
    {
      sku: 'CZ-HEART-PNK-7.0',
      name: 'Đá CZ hình trái tim màu hồng 7.0',
      locationCode: null,
      unitId: unit.vien,
      materialTypeId: type.cz,
      shapeId: shape.traiTim,
      colorId: color.hong,
      sizeLabel: '7.0',
      sortOrder: 10,
      openingQty: '20',
      openingAmount: '0',
      inQty: '0',
      inAmount: '0',
      outQty: '0',
      outAmount: '0',
      qty: '20',
      amount: '0',
    },
    {
      sku: 'TEST-LECH-NXT',
      name: 'NVL test lệch công thức NXT',
      locationCode: 'TEST',
      unitId: unit.vien,
      materialTypeId: type.cz,
      shapeId: shape.tron,
      colorId: color.trang,
      sizeLabel: 'test',
      sortOrder: 11,
      openingQty: '50',
      openingAmount: '100000',
      inQty: '10',
      inAmount: '20000',
      outQty: '2',
      outAmount: '4000',
      qty: '8',
      amount: '16000',
    },
  ];

  for (const row of samples) {
    const material = await prisma.material.upsert({
      where: {
        warehouseId_sku: { warehouseId: warehouse.id, sku: row.sku },
      },
      update: {
        name: row.name,
        locationCode: row.locationCode,
        unitId: row.unitId,
        materialTypeId: row.materialTypeId,
        shapeId: row.shapeId,
        colorId: row.colorId,
        sizeLabel: row.sizeLabel,
        quality: row.quality ?? null,
        sortOrder: row.sortOrder,
        isActive: true,
      },
      create: {
        warehouseId: warehouse.id,
        sku: row.sku,
        name: row.name,
        locationCode: row.locationCode,
        unitId: row.unitId,
        materialTypeId: row.materialTypeId,
        shapeId: row.shapeId,
        colorId: row.colorId,
        sizeLabel: row.sizeLabel,
        quality: row.quality ?? null,
        sortOrder: row.sortOrder,
      },
    });

    await prisma.stockBalance.upsert({
      where: { materialId: material.id },
      update: {
        warehouseId: warehouse.id,
        openingQty: row.openingQty,
        openingAmount: row.openingAmount,
        inQty: row.inQty,
        inAmount: row.inAmount,
        outQty: row.outQty,
        outAmount: row.outAmount,
        qty: row.qty,
        amount: row.amount,
      },
      create: {
        warehouseId: warehouse.id,
        materialId: material.id,
        openingQty: row.openingQty,
        openingAmount: row.openingAmount,
        inQty: row.inQty,
        inAmount: row.inAmount,
        outQty: row.outQty,
        outAmount: row.outAmount,
        qty: row.qty,
        amount: row.amount,
      },
    });
  }
}

type SheetInbound = {
  stt: number;
  date: string;
  name: string;
  unit: string;
  qty: number;
  unitPrice: number;
  amount: number;
  note: string | null;
  supplierSku: string | null;
  supplier: string | null;
};

function parseSheetDate(value: string) {
  const parts = value.split(/[/-]/).map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return new Date('2026-01-01T00:00:00.000Z');
  }
  const [a, b, year] = parts;
  if (a > 12) return new Date(Date.UTC(year, b - 1, a));
  if (b > 12) return new Date(Date.UTC(year, a - 1, b));
  return new Date(Date.UTC(year, a - 1, b));
}

async function seedDaInbounds() {
  const warehouse = await mustCode(
    await prisma.warehouse.findUnique({ where: { code: 'da' } }),
    'kho da',
  );
  const units = await prisma.unit.findMany({ select: { id: true, code: true, name: true } });
  const unitByName = new Map(units.map((u) => [u.name.toLowerCase(), u]));
  const fallbackUnit =
    unitByName.get('viên') ?? units.find((u) => u.code === 'vien') ?? units[0];
  if (!fallbackUnit) throw new Error('Thiếu đơn vị tính');
  const suppliers = await prisma.supplier.findMany({
    select: { id: true, code: true, name: true },
  });
  const supplierByName = new Map(suppliers.map((s) => [s.name.toLowerCase(), s]));
  const materials = await prisma.material.findMany({
    where: { warehouseId: warehouse.id, isActive: true },
    select: { id: true, name: true, sku: true },
  });
  const materialByName = new Map(materials.map((m) => [m.name.toLowerCase(), m]));
  const existingIds = new Set(materials.map((m) => m.id));
  const last = await prisma.material.aggregate({
    where: { warehouseId: warehouse.id, isActive: true },
    _max: { sortOrder: true },
  });
  let nextSort = (last._max.sortOrder ?? 0) + 1;

  const file = join(__dirname, 'data/stone-inbounds.json');
  const rows = JSON.parse(readFileSync(file, 'utf8')) as SheetInbound[];
  const createdIds = new Set<string>();

  for (const row of rows) {
    const unit = unitByName.get(row.unit.toLowerCase()) ?? fallbackUnit;
    const supplier = row.supplier
      ? supplierByName.get(row.supplier.toLowerCase()) ?? null
      : null;
    let material = materialByName.get(row.name.toLowerCase()) ?? null;
    if (!material) {
      material = await prisma.material.create({
        data: {
          warehouseId: warehouse.id,
          name: row.name,
          unitId: unit.id,
          classification: MaterialClass.RAW_MATERIAL,
          sortOrder: nextSort++,
        },
        select: { id: true, name: true, sku: true },
      });
      await prisma.stockBalance.create({
        data: { warehouseId: warehouse.id, materialId: material.id },
      });
      materialByName.set(row.name.toLowerCase(), material);
      createdIds.add(material.id);
    }
    await prisma.stockInbound.upsert({
      where: {
        warehouseId_sortOrder: { warehouseId: warehouse.id, sortOrder: row.stt },
      },
      update: {
        receivedAt: parseSheetDate(row.date),
        name: row.name,
        sku: material.sku ?? null,
        unitId: unit.id,
        unitName: unit.name,
        qty: String(row.qty),
        unitPrice: String(row.unitPrice),
        amount: String(row.amount),
        note: row.note,
        supplierSku: row.supplierSku,
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? row.supplier,
        materialId: material.id,
        applyToStock: false,
      },
      create: {
        warehouseId: warehouse.id,
        sortOrder: row.stt,
        receivedAt: parseSheetDate(row.date),
        name: row.name,
        sku: material.sku ?? null,
        unitId: unit.id,
        unitName: unit.name,
        qty: String(row.qty),
        unitPrice: String(row.unitPrice),
        amount: String(row.amount),
        note: row.note,
        supplierSku: row.supplierSku,
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? row.supplier,
        materialId: material.id,
        applyToStock: false,
      },
    });
  }

  if (createdIds.size === 0) return;

  const sums = await prisma.stockInbound.groupBy({
    by: ['materialId'],
    where: { warehouseId: warehouse.id, materialId: { in: [...createdIds] } },
    _sum: { qty: true, amount: true },
  });
  for (const row of sums) {
    if (!row.materialId || existingIds.has(row.materialId)) continue;
    await prisma.stockBalance.update({
      where: { materialId: row.materialId },
      data: {
        qty: row._sum.qty ?? 0,
        amount: row._sum.amount ?? 0,
      },
    });
  }
}

type SheetOutbound = {
  stt: number;
  date: string;
  sku: string | null;
  name: string;
  unit: string;
  qty: number;
  stockUnitPrice: number;
  inboundUnitPrice: number;
  amount: number;
  note: string | null;
  issuedBy: string | null;
  receivedBy: string | null;
};

async function seedDaOutbounds() {
  const warehouse = await mustCode(
    await prisma.warehouse.findUnique({ where: { code: 'da' } }),
    'kho da',
  );
  const units = await prisma.unit.findMany({ select: { id: true, code: true, name: true } });
  const unitByName = new Map(units.map((u) => [u.name.toLowerCase(), u]));
  const fallbackUnit =
    unitByName.get('viên') ?? units.find((u) => u.code === 'vien') ?? units[0];
  if (!fallbackUnit) throw new Error('Thiếu đơn vị tính');
  const materials = await prisma.material.findMany({
    where: { warehouseId: warehouse.id, isActive: true },
    select: { id: true, name: true, sku: true },
  });
  const materialByName = new Map(materials.map((m) => [m.name.toLowerCase(), m]));
  const last = await prisma.material.aggregate({
    where: { warehouseId: warehouse.id, isActive: true },
    _max: { sortOrder: true },
  });
  let nextSort = (last._max.sortOrder ?? 0) + 1;

  const file = join(__dirname, 'data/stone-outbounds.json');
  const rows = JSON.parse(readFileSync(file, 'utf8')) as SheetOutbound[];

  for (const row of rows) {
    const unit = unitByName.get(row.unit.toLowerCase()) ?? fallbackUnit;
    let material = materialByName.get(row.name.toLowerCase()) ?? null;
    if (!material) {
      material = await prisma.material.create({
        data: {
          warehouseId: warehouse.id,
          name: row.name,
          sku: row.sku,
          unitId: unit.id,
          classification: MaterialClass.RAW_MATERIAL,
          sortOrder: nextSort++,
        },
        select: { id: true, name: true, sku: true },
      });
      await prisma.stockBalance.create({
        data: { warehouseId: warehouse.id, materialId: material.id },
      });
      materialByName.set(row.name.toLowerCase(), material);
    }
    await prisma.stockOutbound.upsert({
      where: {
        warehouseId_sortOrder: { warehouseId: warehouse.id, sortOrder: row.stt },
      },
      update: {
        issuedAt: parseSheetDate(row.date),
        name: row.name,
        sku: material.sku ?? row.sku,
        unitId: unit.id,
        unitName: unit.name,
        qty: String(row.qty),
        stockUnitPrice: String(row.stockUnitPrice),
        inboundUnitPrice: String(row.inboundUnitPrice),
        amount: String(row.amount),
        note: row.note,
        issuedBy: row.issuedBy,
        receivedBy: row.receivedBy,
        materialId: material.id,
        applyToStock: false,
      },
      create: {
        warehouseId: warehouse.id,
        sortOrder: row.stt,
        issuedAt: parseSheetDate(row.date),
        name: row.name,
        sku: material.sku ?? row.sku,
        unitId: unit.id,
        unitName: unit.name,
        qty: String(row.qty),
        stockUnitPrice: String(row.stockUnitPrice),
        inboundUnitPrice: String(row.inboundUnitPrice),
        amount: String(row.amount),
        note: row.note,
        issuedBy: row.issuedBy,
        receivedBy: row.receivedBy,
        materialId: material.id,
        applyToStock: false,
      },
    });
  }
}

async function main() {
  await seedUsers();
  await seedLookups();
  await seedWarehouses();
  await seedDaStock();
  await seedDaInbounds();
  await seedDaOutbounds();

  console.log('Seed OK — password:', DEMO_PASSWORD);
  console.log('  admin  ADMIN');
  console.log('  user   USER');
  console.log('  warehouses: nvl-chinh (bac + BTP, da), nvl-tieu-hao');
  console.log('  sample stock: 10 NVL kho đá + NVL tạo từ phiếu nhập/xuất');
  console.log('  kho nhập đá: 97 dòng từ sheet Nhập kho đá (gắn NVL, hiện Nhập trên kho tồn)');
  console.log('  kho xuất đá: 97 dòng từ sheet Xuất NVL đá (gắn NVL, hiện Xuất trên kho tồn)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
