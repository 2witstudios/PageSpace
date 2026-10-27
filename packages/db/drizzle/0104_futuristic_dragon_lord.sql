ALTER TABLE "auth_handoff_tokens" DROP CONSTRAINT "auth_handoff_tokens_pkey";--> statement-breakpoint
ALTER TABLE "auth_handoff_tokens" ADD CONSTRAINT "auth_handoff_tokens_token_hash_kind_pk" PRIMARY KEY("token_hash","kind");
