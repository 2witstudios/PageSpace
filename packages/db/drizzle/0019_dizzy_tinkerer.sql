ALTER TABLE "subscriptions" ADD COLUMN "stripeScheduleId" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "scheduledPriceId" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "scheduledChangeDate" timestamp;