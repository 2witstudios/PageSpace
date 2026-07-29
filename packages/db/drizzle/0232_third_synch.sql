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
	"conversationId" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"agentPageId" text,
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
ALTER TABLE "agent_session_shells" ADD CONSTRAINT "agent_session_shells_sessionId_agent_sessions_conversationId_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."agent_sessions"("conversationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_shells" ADD CONSTRAINT "agent_session_shells_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_conversationId_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agentPageId_pages_id_fk" FOREIGN KEY ("agentPageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_session_shells_session_id_idx" ON "agent_session_shells" USING btree ("sessionId");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_shells_session_name_idx" ON "agent_session_shells" USING btree ("sessionId","name");--> statement-breakpoint
CREATE INDEX "agent_sessions_agent_page_id_idx" ON "agent_sessions" USING btree ("agentPageId");--> statement-breakpoint
CREATE INDEX "agent_sessions_owner_id_idx" ON "agent_sessions" USING btree ("ownerId");