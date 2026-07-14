CREATE TABLE "ai_pending_abort_intents" (
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_pending_abort_intents_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
