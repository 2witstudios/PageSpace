--> Hand-written rather than generated, for two reasons, both learned the hard way.
-->
--> 1. `ADD COLUMN ... NOT NULL` with no default fails (23502) on any database
-->    that already holds a grant row, and grants are not deleted after
-->    redemption or expiry. All pending migrations run in ONE invocation, so a
-->    dev or staging database where the feature was ever switched on would
-->    take the whole release down with it. Clearing the table costs nothing: a
-->    grant is a single-use, sixty-second handshake token, so the worst case
-->    for anyone holding one is "this preview link has expired, reopen the
-->    preview from PageSpace" and the next click mints a fresh one.
-->
--> 2. This runner keys applied migrations BY HASH of the file text, so editing
-->    this file at all makes every database that already applied the earlier
-->    version run it again. Every statement below is therefore written to be
-->    safe on a second pass — which is also what makes the fix in (1) reach
-->    the databases that need it without breaking the ones that do not.
DELETE FROM "dev_preview_grants";--> statement-breakpoint
ALTER TABLE "dev_preview_grants" ADD COLUMN IF NOT EXISTS "sessionId" text NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dev_preview_grants_sessionId_sessions_id_fk') THEN
		ALTER TABLE "dev_preview_grants" ADD CONSTRAINT "dev_preview_grants_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
