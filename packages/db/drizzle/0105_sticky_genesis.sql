DO $$ BEGIN
 CREATE TYPE "public"."AgentRunEventType" AS ENUM('text-segment', 'tool-input', 'tool-result', 'metadata', 'finish', 'error', 'aborted');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."AgentRunStatus" AS ENUM('pending', 'streaming', 'completed', 'failed', 'aborted');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_run_events" (
	"runId" text NOT NULL,
	"seq" integer NOT NULL,
	"type" "AgentRunEventType" NOT NULL,
	"payload" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_events_runId_seq_pk" PRIMARY KEY("runId","seq")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerUserId" text NOT NULL,
	"conversationId" text NOT NULL,
	"agentScope" text NOT NULL,
	"agentContextId" text,
	"parentMessageId" text,
	"status" "AgentRunStatus" DEFAULT 'pending' NOT NULL,
	"modelConfig" jsonb NOT NULL,
	"lastSeq" integer DEFAULT 0 NOT NULL,
	"tokenUsageInput" integer DEFAULT 0 NOT NULL,
	"tokenUsageOutput" integer DEFAULT 0 NOT NULL,
	"costCents" bigint DEFAULT 0 NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"lastHeartbeatAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp,
	"errorMessage" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_runId_agent_runs_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_ownerUserId_users_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversationId_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parentMessageId_messages_id_fk" FOREIGN KEY ("parentMessageId") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_events_run_id_created_at_idx" ON "agent_run_events" USING btree ("runId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_conversation_id_idx" ON "agent_runs" USING btree ("conversationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_owner_user_id_idx" ON "agent_runs" USING btree ("ownerUserId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_status_heartbeat_idx" ON "agent_runs" USING btree ("status","lastHeartbeatAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_parent_message_id_idx" ON "agent_runs" USING btree ("parentMessageId");