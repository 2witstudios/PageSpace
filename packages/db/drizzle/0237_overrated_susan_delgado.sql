CREATE TABLE "agent_session_shells" (
	"id" text PRIMARY KEY NOT NULL,
	"sessionId" text NOT NULL,
	"ownerId" text NOT NULL,
	"name" text NOT NULL,
	"agentType" text NOT NULL,
	"command" text,
	"streamSessionId" text,
	"coldTail" text,
	"coldTailAt" timestamp,
	"coldTailHasOutput" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text,
	"ownerId" text NOT NULL,
	"name" text,
	"sessionKey" text,
	"sandboxId" text,
	"spriteInstanceId" text,
	"egressPolicyToken" text,
	"teardownRequestedAt" timestamp,
	"spriteTornDownAt" timestamp,
	"storageLastBilledAt" timestamp DEFAULT now() NOT NULL,
	"storageMeasuredBytes" bigint,
	"storageMeasuredAt" timestamp,
	"lastActiveAt" timestamp,
	"endedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "sessionId" text;--> statement-breakpoint
ALTER TABLE "agent_session_shells" ADD CONSTRAINT "agent_session_shells_sessionId_agent_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_shells" ADD CONSTRAINT "agent_session_shells_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_shells_session_id_idx" ON "agent_session_shells" USING btree ("sessionId");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_shells_session_name_idx" ON "agent_session_shells" USING btree ("sessionId","name");--> statement-breakpoint
CREATE INDEX "agent_sessions_drive_id_idx" ON "agent_sessions" USING btree ("driveId");--> statement-breakpoint
CREATE INDEX "agent_sessions_owner_id_idx" ON "agent_sessions" USING btree ("ownerId");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_sessionId_agent_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_session_id_idx" ON "conversations" USING btree ("sessionId");