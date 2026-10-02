-- DB dev: bảng casting_slips còn intake_order_id (schema cũ) + thiếu cột workflow trên main.

ALTER TYPE "CastingSlipStatus" ADD VALUE IF NOT EXISTS 'PENDING_ISSUE';

DO $$
BEGIN
    CREATE TYPE "CastingSlipImageKind" AS ENUM ('ISSUE', 'RESULT');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "casting_slip_images"
ADD COLUMN IF NOT EXISTS "kind" "CastingSlipImageKind" NOT NULL DEFAULT 'ISSUE';

ALTER TABLE "casting_slips"
ADD COLUMN IF NOT EXISTS "cast_tree_weight_gram" DECIMAL(18, 4),
ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "confirmed_by_name" TEXT,
ADD COLUMN IF NOT EXISTS "plaster_used_gram" DECIMAL(18, 4),
ADD COLUMN IF NOT EXISTS "silver_used_gram" DECIMAL(18, 4),
ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "started_by_name" TEXT,
ADD COLUMN IF NOT EXISTS "started_by_user_id" UUID,
ADD COLUMN IF NOT EXISTS "submitted_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "submitted_by_name" TEXT,
ADD COLUMN IF NOT EXISTS "submitted_by_user_id" UUID,
ADD COLUMN IF NOT EXISTS "created_by_name" TEXT,
ADD COLUMN IF NOT EXISTS "last_printed_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "casting_slips_started_by_user_id_idx"
    ON "casting_slips"("started_by_user_id");

-- FK cũ trỏ nhầm bảng legacy sau khi rename.
ALTER TABLE "casting_slip_orders" DROP CONSTRAINT IF EXISTS "casting_slip_orders_slip_id_fkey";

-- Dòng lô trỏ slip đã mất — gây lỗi Prisma "slip is required, got null".
DELETE FROM "casting_slip_orders" cso
WHERE NOT EXISTS (SELECT 1 FROM "casting_slips" cs WHERE cs."id" = cso."slip_id");

-- Gắn đơn còn intake_order_id trên phiếu (schema cũ) vào bảng lô.
INSERT INTO "casting_slip_orders" ("id", "slip_id", "intake_order_id", "sort_order", "wax_weight_gram")
SELECT gen_random_uuid(), s."id", s."intake_order_id", 0, s."wax_weight_gram"
FROM "casting_slips" s
WHERE s."intake_order_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "casting_slip_orders" o WHERE o."intake_order_id" = s."intake_order_id"
  );

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'casting_slips'
          AND column_name = 'intake_order_id'
    ) THEN
        ALTER TABLE "casting_slips" DROP CONSTRAINT IF EXISTS "casting_slips_intake_order_id_fkey";
        DROP INDEX IF EXISTS "casting_slips_intake_order_id_key";
        DROP INDEX IF EXISTS "casting_slips_intake_order_id_idx";
        ALTER TABLE "casting_slips" DROP COLUMN "intake_order_id";
    END IF;
END $$;

ALTER TABLE "casting_slips" DROP COLUMN IF EXISTS "assigned_user_id";
ALTER TABLE "casting_slips" DROP COLUMN IF EXISTS "assigned_user_name";

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'casting_slip_orders_slip_id_fkey'
    ) THEN
        ALTER TABLE "casting_slip_orders"
            ADD CONSTRAINT "casting_slip_orders_slip_id_fkey"
            FOREIGN KEY ("slip_id") REFERENCES "casting_slips"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
