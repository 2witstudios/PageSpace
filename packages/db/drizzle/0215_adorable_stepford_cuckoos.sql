ALTER TABLE "webhook_triggers" ALTER COLUMN "connectionId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_triggers" ADD COLUMN "pageWebhookId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_pageWebhookId_page_webhooks_id_fk" FOREIGN KEY ("pageWebhookId") REFERENCES "public"."page_webhooks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_triggers_page_webhook_id_idx" ON "webhook_triggers" USING btree ("pageWebhookId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_triggers_page_webhook_workflow_unique" ON "webhook_triggers" USING btree ("pageWebhookId","workflowId") WHERE "webhook_triggers"."pageWebhookId" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "webhook_triggers" ADD CONSTRAINT "webhook_triggers_anchor_chk" CHECK (
    ("connectionId" IS NOT NULL AND "pageWebhookId" IS NULL) OR ("connectionId" IS NULL AND "pageWebhookId" IS NOT NULL)
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
