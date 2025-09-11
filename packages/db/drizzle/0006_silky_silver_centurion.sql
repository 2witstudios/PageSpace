ALTER TYPE "PageType" ADD VALUE 'FILE';--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "fileSize" real;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "mimeType" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "originalFileName" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "filePath" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "fileMetadata" jsonb;