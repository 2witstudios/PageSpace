ALTER TABLE "org_subscriptions" ADD COLUMN "giftedExtraSeats" integer;--> statement-breakpoint
ALTER TABLE "org_subscriptions" ADD COLUMN "giftRevision" integer DEFAULT 0 NOT NULL;