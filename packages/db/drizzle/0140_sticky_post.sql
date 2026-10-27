ALTER TYPE "WorkflowRunSourceTable" ADD VALUE 'webhookTriggers';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"workflowId" text NOT NULL,
	"connectionId" text NOT NULL,
	"provider" text NOT NULL,
	"eventType" text NOT NULL,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"lastFiredAt" timestamp,
	"lastFireError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_workflowId_workflows_id_fk" FOREIGN KEY ("workflowId") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_connectionId_zoom_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."zoom_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_triggers_workflow_id_idx" ON "webhook_triggers" USING btree ("workflowId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_triggers_provider_event_idx" ON "webhook_triggers" USING btree ("provider","eventType","isEnabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_triggers_connection_id_idx" ON "webhook_triggers" USING btree ("connectionId");