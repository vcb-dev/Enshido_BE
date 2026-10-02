-- Legacy/manual status not in Prisma schema — map to WAIT_CASTING so API can list orders.
UPDATE "intake_orders"
SET "status" = 'WAIT_CASTING'
WHERE "status"::text = 'WAIT_COOLING';
