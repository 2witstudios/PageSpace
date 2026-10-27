ALTER TABLE "stripe_events" ALTER COLUMN "processedAt" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "stripe_events" ALTER COLUMN "processedAt" DROP NOT NULL;