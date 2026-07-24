ALTER TABLE "machine_agent_terminals" ADD COLUMN "sessionKey" text;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "sandboxId" text;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "spriteInstanceId" text;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "egressPolicyToken" text;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "teardownRequestedAt" timestamp;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "spriteTornDownAt" timestamp;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "storageLastBilledAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "storageMeasuredBytes" bigint;--> statement-breakpoint
ALTER TABLE "machine_agent_terminals" ADD COLUMN "storageMeasuredAt" timestamp;