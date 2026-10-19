CREATE TABLE "app_store_accounts" (
	"userId" text PRIMARY KEY NOT NULL,
	"accountToken" uuid NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_store_accounts_accountToken_unique" UNIQUE("accountToken")
);
--> statement-breakpoint
CREATE TABLE "app_store_notifications" (
	"notificationUUID" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"subtype" text,
	"processedAt" timestamp with time zone,
	"error" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_store_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"originalTransactionId" text NOT NULL,
	"latestTransactionId" text NOT NULL,
	"productId" text NOT NULL,
	"status" text NOT NULL,
	"environment" text NOT NULL,
	"currentPeriodStart" timestamp with time zone NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"autoRenew" boolean DEFAULT true NOT NULL,
	"lastSignedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_store_subscriptions_originalTransactionId_unique" UNIQUE("originalTransactionId"),
	CONSTRAINT "app_store_subscriptions_status_valid" CHECK ("app_store_subscriptions"."status" IN ('active', 'billing_retry', 'grace_period', 'expired', 'revoked')),
	CONSTRAINT "app_store_subscriptions_environment_valid" CHECK ("app_store_subscriptions"."environment" IN ('Production', 'Sandbox'))
);
--> statement-breakpoint
CREATE TABLE "app_store_transactions" (
	"transactionId" text PRIMARY KEY NOT NULL,
	"originalTransactionId" text NOT NULL,
	"userId" text,
	"productId" text NOT NULL,
	"productKind" text NOT NULL,
	"environment" text NOT NULL,
	"purchaseDate" timestamp with time zone NOT NULL,
	"expiresDate" timestamp with time zone,
	"priceMilliunits" integer,
	"currency" text,
	"storefront" text,
	"revokedAt" timestamp with time zone,
	"lastSignedAt" timestamp with time zone,
	"fundedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_store_transactions_kind_valid" CHECK ("app_store_transactions"."productKind" IN ('subscription', 'consumable'))
);
--> statement-breakpoint
ALTER TABLE "app_store_accounts" ADD CONSTRAINT "app_store_accounts_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_store_subscriptions" ADD CONSTRAINT "app_store_subscriptions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_store_transactions" ADD CONSTRAINT "app_store_transactions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_store_notifications_processed_at_idx" ON "app_store_notifications" USING btree ("processedAt");--> statement-breakpoint
CREATE INDEX "app_store_subscriptions_user_idx" ON "app_store_subscriptions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "app_store_transactions_user_idx" ON "app_store_transactions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "app_store_transactions_original_idx" ON "app_store_transactions" USING btree ("originalTransactionId");