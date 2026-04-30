CREATE TABLE IF NOT EXISTS "ai_stream_sessions" (
	"message_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text DEFAULT 'Someone' NOT NULL,
	"tab_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'streaming' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_stream_sessions_channel_status_idx" ON "ai_stream_sessions" USING btree ("channel_id","status");