ALTER TABLE "pages" ADD COLUMN "processingStatus" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "processingError" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "processedAt" timestamp;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "extractionMethod" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "extractionMetadata" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "contentHash" text;