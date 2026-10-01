CREATE TABLE "ai_tool_approval_decisions" (
	"approval_id" text PRIMARY KEY NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"message_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"approved" boolean NOT NULL,
	"reason" text,
	"scope" text,
	"decided_at" timestamp DEFAULT now() NOT NULL,
	"executed_at" timestamp,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "ai_tool_approval_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"conversation_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "toolApprovalMode" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "global_assistant_config" ADD COLUMN "tool_approval_mode" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_tool_approval_decisions" ADD CONSTRAINT "ai_tool_approval_decisions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_approval_decisions" ADD CONSTRAINT "ai_tool_approval_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_approval_grants" ADD CONSTRAINT "ai_tool_approval_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_approval_grants" ADD CONSTRAINT "ai_tool_approval_grants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_tool_approval_decisions_conversation_idx" ON "ai_tool_approval_decisions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ai_tool_approval_decisions_message_idx" ON "ai_tool_approval_decisions" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tool_approval_grants_user_tool_conv_idx" ON "ai_tool_approval_grants" USING btree ("user_id","tool_name","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tool_approval_grants_user_tool_always_idx" ON "ai_tool_approval_grants" USING btree ("user_id","tool_name") WHERE conversation_id IS NULL;--> statement-breakpoint
CREATE INDEX "ai_tool_approval_grants_user_idx" ON "ai_tool_approval_grants" USING btree ("user_id");