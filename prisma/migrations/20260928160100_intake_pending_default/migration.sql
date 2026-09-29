UPDATE "intake_orders" SET "status" = 'PENDING_APPROVAL' WHERE "status" = 'NEW';

ALTER TABLE "intake_orders" ALTER COLUMN "status" SET DEFAULT 'PENDING_APPROVAL';
