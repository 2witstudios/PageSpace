ALTER TABLE "sessions" ADD COLUMN "device_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_device_idx" ON "sessions" USING btree ("user_id","device_id");