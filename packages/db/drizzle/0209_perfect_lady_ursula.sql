CREATE TABLE IF NOT EXISTS "machine_sprite_reclaims" (
	"sandboxId" text PRIMARY KEY NOT NULL,
	"recordedAt" timestamp DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastAttemptAt" timestamp,
	"lastError" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_sprite_reclaims_recorded_at_idx" ON "machine_sprite_reclaims" USING btree ("recordedAt");