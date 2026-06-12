CREATE TABLE IF NOT EXISTS "conversation_compactions" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"page_id" text,
	"summary" text DEFAULT '' NOT NULL,
	"summary_tokens" integer DEFAULT 0 NOT NULL,
	"compacted_up_to_message_id" text,
	"compacted_up_to_created_at" timestamp,
	"summary_version" integer DEFAULT 1 NOT NULL,
	"summarizer_model" text,
	"last_compacted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_compactions_page_id_idx" ON "conversation_compactions" USING btree ("page_id");