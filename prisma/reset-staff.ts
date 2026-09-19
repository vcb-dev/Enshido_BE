import { PrismaClient, RoleCode } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'Admin@123';
const BCRYPT_COST = 8;

async function main() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "allowed_screens" TEXT[] NOT NULL DEFAULT '{}';
  `);

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  const keepUsernames = ['admin', 'phuong-mai', 'hai-yen'];
  await prisma.user.deleteMany({
    where: { username: { notIn: keepUsernames } },
  });

  const users = [
    {
      username: 'admin',
      fullName: 'Admin Enshido',
      roleCode: RoleCode.ADMIN,
      extraRoles: [] as RoleCode[],
      department: 'IT',
      allowedScreens: [] as string[],
    },
    {
      username: 'phuong-mai',
      fullName: 'Phương Mai',
      roleCode: RoleCode.USER,
      extraRoles: [] as RoleCode[],
      department: 'Quản lý kho',
      allowedScreens: [
        'screen.dashboard',
        'screen.warehouse.nvl-chinh',
        'screen.warehouse.btp-cho-vao-da',
        'screen.warehouse.nvl-tieu-hao',
        'screen.warehouse.thanh-pham',
        'screen.locations',
      ],
    },
    {
      username: 'hai-yen',
      fullName: 'Hải Yến',
      roleCode: RoleCode.USER,
      extraRoles: [] as RoleCode[],
      department: 'Kế toán',
      allowedScreens: [
        'screen.dashboard',
        'screen.warehouse.nvl-chinh',
        'screen.warehouse.btp-cho-vao-da',
        'screen.warehouse.nvl-tieu-hao',
        'screen.warehouse.thanh-pham',
      ],
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
        allowedScreens: u.allowedScreens,
        isActive: true,
      },
      create: {
        username: u.username,
        passwordHash,
        fullName: u.fullName,
        roleCode: u.roleCode,
        extraRoles: u.extraRoles,
        department: u.department,
        allowedScreens: u.allowedScreens,
        isActive: true,
      },
    });
  }

  console.log('Staff reset OK — password:', DEMO_PASSWORD);
  console.log('  admin       Admin Enshido');
  console.log('  phuong-mai  Phương Mai (Quản lý kho)');
  console.log('  hai-yen     Hải Yến (Kế toán)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
