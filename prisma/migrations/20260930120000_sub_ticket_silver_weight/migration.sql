-- Một số DB deploy sớm chưa có cột gram bạc trên phiếu con (Prisma P2022).
ALTER TABLE "production_sub_tickets"
ADD COLUMN IF NOT EXISTS "silver_weight" DECIMAL(18,4);

UPDATE "production_sub_tickets"
SET "silver_weight" = 0
WHERE "silver_weight" IS NULL;

ALTER TABLE "production_sub_tickets"
ALTER COLUMN "silver_weight" SET DEFAULT 0;

ALTER TABLE "production_sub_tickets"
ALTER COLUMN "silver_weight" SET NOT NULL;
