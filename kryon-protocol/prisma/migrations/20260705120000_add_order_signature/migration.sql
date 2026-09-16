-- Repair migration: the `signature` column was added to production ad-hoc via
-- client/scripts/migrate-add-order-signature.ts (2026-06). IF NOT EXISTS makes
-- this a no-op there and a real ADD COLUMN on fresh databases, restoring
-- `prisma migrate deploy` as the single migration path.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "signature" TEXT;
