-- Repair drift: DB created/evolved before full 0_init + intake casting_slips conflict.

ALTER TABLE "production_orders"
ADD COLUMN IF NOT EXISTS "silver_weight" DECIMAL(18, 4);

CREATE TABLE IF NOT EXISTS "production_sub_ticket_top_ups" (
    "id" UUID NOT NULL,
    "sub_ticket_id" UUID NOT NULL,
    "stage_entry_id" UUID,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "silver_weight" DECIMAL(18, 4) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "created_by_user_id" UUID,
    "created_by_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_sub_ticket_top_ups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "production_sub_ticket_top_ups_sub_ticket_id_idx"
    ON "production_sub_ticket_top_ups"("sub_ticket_id");

CREATE INDEX IF NOT EXISTS "production_sub_ticket_top_ups_stage_entry_id_idx"
    ON "production_sub_ticket_top_ups"("stage_entry_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'production_sub_ticket_top_ups_sub_ticket_id_fkey'
    ) THEN
        ALTER TABLE "production_sub_ticket_top_ups"
            ADD CONSTRAINT "production_sub_ticket_top_ups_sub_ticket_id_fkey"
            FOREIGN KEY ("sub_ticket_id") REFERENCES "production_sub_tickets"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'production_sub_ticket_top_ups_stage_entry_id_fkey'
    ) THEN
        ALTER TABLE "production_sub_ticket_top_ups"
            ADD CONSTRAINT "production_sub_ticket_top_ups_stage_entry_id_fkey"
            FOREIGN KEY ("stage_entry_id") REFERENCES "production_stage_entries"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- Legacy casting_slips (workflow) blocked intake migration CREATE TABLE; rename then recreate.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'casting_slips'
          AND column_name = 'status'
    )
    AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'casting_slips'
          AND column_name = 'intake_order_id'
    ) THEN
        ALTER TABLE "casting_slips" RENAME TO "casting_slips_legacy_workflow";
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'casting_slips_pkey') THEN
            ALTER TABLE "casting_slips_legacy_workflow"
                RENAME CONSTRAINT "casting_slips_pkey" TO "casting_slips_legacy_workflow_pkey";
        END IF;
        IF EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname = current_schema()
              AND indexname = 'casting_slips_code_key'
        ) THEN
            ALTER INDEX "casting_slips_code_key" RENAME TO "casting_slips_legacy_workflow_code_key";
        END IF;
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_name = 'casting_slip_images'
        ) THEN
            ALTER TABLE "casting_slip_images" RENAME TO "casting_slip_images_legacy";
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'casting_slip_images_pkey') THEN
                ALTER TABLE "casting_slip_images_legacy"
                    RENAME CONSTRAINT "casting_slip_images_pkey" TO "casting_slip_images_legacy_pkey";
            END IF;
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'casting_slip_images_slip_id_fkey') THEN
                ALTER TABLE "casting_slip_images_legacy"
                    RENAME CONSTRAINT "casting_slip_images_slip_id_fkey"
                    TO "casting_slip_images_legacy_slip_id_fkey";
            END IF;
            IF EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = current_schema()
                  AND indexname = 'casting_slip_images_slip_id_sort_order_idx'
            ) THEN
                ALTER INDEX "casting_slip_images_slip_id_sort_order_idx"
                    RENAME TO "casting_slip_images_legacy_slip_id_sort_order_idx";
            END IF;
        END IF;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "casting_slips" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "slip_date" DATE NOT NULL,
    "intake_order_id" UUID NOT NULL,
    "wax_weight_gram" DECIMAL(18, 4) NOT NULL,
    "batch_order_codes" TEXT NOT NULL,
    "issue_s999_gram" DECIMAL(18, 4),
    "issue_master_alloy_gram" DECIMAL(18, 4),
    "issue_s925_gram" DECIMAL(18, 4),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "casting_slips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "casting_slips_code_key" ON "casting_slips"("code");

CREATE INDEX IF NOT EXISTS "casting_slips_slip_date_idx" ON "casting_slips"("slip_date");

CREATE INDEX IF NOT EXISTS "casting_slips_intake_order_id_idx" ON "casting_slips"("intake_order_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'casting_slips_intake_order_id_fkey'
    ) THEN
        ALTER TABLE "casting_slips"
            ADD CONSTRAINT "casting_slips_intake_order_id_fkey"
            FOREIGN KEY ("intake_order_id") REFERENCES "intake_orders"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- casting_slip_images may already exist (FK still points at legacy table after rename).
CREATE TABLE IF NOT EXISTS "casting_slip_images" (
    "id" UUID NOT NULL,
    "slip_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "casting_slip_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "casting_slip_images_slip_id_sort_order_idx"
    ON "casting_slip_images"("slip_id", "sort_order");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'casting_slip_images_slip_id_fkey'
    ) THEN
        ALTER TABLE "casting_slip_images"
            ADD CONSTRAINT "casting_slip_images_slip_id_fkey"
            FOREIGN KEY ("slip_id") REFERENCES "casting_slips"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
