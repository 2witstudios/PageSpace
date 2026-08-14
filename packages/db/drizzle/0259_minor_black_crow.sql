CREATE TABLE "ai_stream_frames" (
	"message_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"from_seq" integer NOT NULL,
	"frame_count" integer NOT NULL,
	"frames" jsonb NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_stream_frames_message_id_from_seq_pk" PRIMARY KEY("message_id","from_seq")
);
--> statement-breakpoint
ALTER TABLE "ai_stream_frames" ADD CONSTRAINT "ai_stream_frames_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_stream_frames_created_at_idx" ON "ai_stream_frames" USING btree ("created_at");