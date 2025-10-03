CREATE TABLE IF NOT EXISTS "verification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"type" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"usedAt" timestamp,
	CONSTRAINT "verification_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_notification_log" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"notificationId" text,
	"notificationType" "NotificationType" NOT NULL,
	"recipientEmail" text NOT NULL,
	"success" boolean NOT NULL,
	"errorMessage" text,
	"sentAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"notificationType" "NotificationType" NOT NULL,
	"emailEnabled" boolean DEFAULT true NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_notification_log" ADD CONSTRAINT "email_notification_log_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_notification_preferences" ADD CONSTRAINT "email_notification_preferences_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_tokens_user_id_idx" ON "verification_tokens" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_tokens_token_idx" ON "verification_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_tokens_type_idx" ON "verification_tokens" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_notification_log_user_idx" ON "email_notification_log" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_notification_log_sent_at_idx" ON "email_notification_log" USING btree ("sentAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_notification_log_notification_id_idx" ON "email_notification_log" USING btree ("notificationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_notification_preferences_user_type_idx" ON "email_notification_preferences" USING btree ("userId","notificationType");