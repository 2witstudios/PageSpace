ALTER TABLE "subscriptions" ADD COLUMN "stripeStorageItemId" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "storageBlocks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "storageGraceBlocks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "storageGraceUntil" timestamp;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "storageRevision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "stripeStorageItemId" text;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "storageBlocks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "storageGraceBlocks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "storageGraceUntil" timestamp;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "storageRevision" integer DEFAULT 0 NOT NULL;