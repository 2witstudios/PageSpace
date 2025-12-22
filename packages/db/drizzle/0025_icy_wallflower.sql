ALTER TYPE "activity_operation" ADD VALUE 'rollback';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"subscriptionTier" text NOT NULL,
	"retentionDays" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "retention_policies_subscriptionTier_unique" UNIQUE("subscriptionTier")
);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "contentFormat" text;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD COLUMN "rollbackFromActivityId" text;