--> Guarded, for the reason 0288 records: this runner keys applied migrations
--> by a hash of the file text, so any later edit makes databases that already
--> ran it run it again — and `Dockerfile.migrate` runs `db:migrate` as the
--> deployment command, so a failing second pass blocks the rollout rather
--> than just the migration. `IF NOT EXISTS` costs nothing and makes the
--> statement idempotent.
ALTER TABLE "dev_preview_services" ADD COLUMN IF NOT EXISTS "selectedByUserAt" timestamp;
