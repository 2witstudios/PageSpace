CREATE TABLE IF NOT EXISTS "page_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"pageId" text NOT NULL,
	"name" text NOT NULL,
	"webhookToken" text NOT NULL,
	"webhookSecretEncrypted" text NOT NULL,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"createdBy" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"lastFiredAt" timestamp,
	"lastFireError" text,
	CONSTRAINT "page_webhooks_webhookToken_unique" UNIQUE("webhookToken")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_webhooks" ADD CONSTRAINT "page_webhooks_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_webhooks" ADD CONSTRAINT "page_webhooks_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_webhooks_page_id_idx" ON "page_webhooks" USING btree ("pageId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_webhooks_token_idx" ON "page_webhooks" USING btree ("webhookToken");--> statement-breakpoint
-- System user for webhook-posted channel messages (channel_messages.userId is
-- NOT NULL). Never added as a drive member; publishWebhookMessage bypasses the
-- human membership/edit-permission check entirely (system-internal call path).
INSERT INTO "users" ("id", "name", "email", "provider", "role", "tokenVersion", "createdAt", "updatedAt")
VALUES ('system-webhooks', 'PageSpace Webhooks', 'webhooks@pagespace.local', 'email', 'user', 0, now(), now())
ON CONFLICT (id) DO NOTHING;