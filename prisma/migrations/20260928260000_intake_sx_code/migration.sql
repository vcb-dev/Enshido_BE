ALTER TABLE "intake_orders" ADD COLUMN "sx_code" TEXT;

UPDATE "intake_orders"
SET "sx_code" = 'S' || lpad("seq"::text, 4, '0')
WHERE "sx_code" IS NULL;

ALTER TABLE "intake_orders" ALTER COLUMN "sx_code" SET NOT NULL;

CREATE UNIQUE INDEX "intake_orders_sx_code_key" ON "intake_orders"("sx_code");
