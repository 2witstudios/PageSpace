ALTER TABLE "machine_agent_terminals" ADD COLUMN "coldTail" text;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "coldTailAt" timestamp;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "coldTailHasOutput" boolean DEFAULT false NOT NULL;