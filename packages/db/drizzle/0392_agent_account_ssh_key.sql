ALTER TYPE "public"."agent_account_kind" ADD VALUE 'ssh_key';--> statement-breakpoint
ALTER TABLE "agent_accounts" ADD COLUMN "publicKey" text;