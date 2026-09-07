--> Hand-added, deliberately: `ADD COLUMN ... NOT NULL` with no default fails
--> (23502) on any database that already holds a grant row, and grants are not
--> deleted after redemption or expiry — so a dev or staging database where the
--> feature was ever switched on would break the whole migration run, and all
--> pending migrations run in one invocation. Clearing them is free: a grant is
--> a single-use, sixty-second handshake token, so the worst case for anyone
--> holding one is that their preview link says "expired, reopen from
--> PageSpace" and the next click mints a fresh one.
DELETE FROM "dev_preview_grants";--> statement-breakpoint
ALTER TABLE "dev_preview_grants" ADD COLUMN "sessionId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dev_preview_grants" ADD CONSTRAINT "dev_preview_grants_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
