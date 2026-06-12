ALTER TABLE "conversation_compactions" DROP CONSTRAINT "conversation_compactions_pkey";--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_conversation_id_source_pk" PRIMARY KEY("conversation_id","source");
