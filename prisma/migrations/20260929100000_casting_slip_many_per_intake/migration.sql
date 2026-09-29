-- Drop unique: one intake may have many casting slips (one per cối).
DROP INDEX IF EXISTS "casting_slips_intake_order_id_key";

CREATE INDEX IF NOT EXISTS "casting_slips_intake_order_id_idx" ON "casting_slips"("intake_order_id");
