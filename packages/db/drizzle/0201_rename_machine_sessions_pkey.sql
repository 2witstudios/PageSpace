-- Postgres does not rename a table's PRIMARY KEY constraint when the table is
-- renamed, and drizzle-kit does not track pkey constraint names in its snapshot
-- (so `db:generate` will never emit this). After 0200 renamed
-- `terminal_sessions` -> `machine_sessions`, the pkey was still called
-- `terminal_sessions_pkey`. Rename it so the schema carries no residual
-- `terminal_*` substrate naming.
--
-- Metadata-only: renaming a constraint rewrites no rows and takes no data lock
-- beyond a brief ACCESS EXCLUSIVE on the catalog entry.
--
-- Guarded so it is a no-op on a database created fresh from a later baseline.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'terminal_sessions_pkey'
  ) THEN
    ALTER TABLE "machine_sessions" RENAME CONSTRAINT "terminal_sessions_pkey" TO "machine_sessions_pkey";
  END IF;
END $$;
