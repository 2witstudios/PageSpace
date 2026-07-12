ALTER TABLE "ai_stream_sessions" ADD COLUMN "stream_id" text;--> statement-breakpoint
ALTER TABLE "ai_stream_sessions" ADD COLUMN "abort_requested_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_stream_sessions_stream_id_idx" ON "ai_stream_sessions" USING btree ("stream_id");