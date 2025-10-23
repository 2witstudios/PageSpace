ALTER TABLE "pages" ADD COLUMN "pageSize" text DEFAULT 'letter' NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "margins" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "showPageNumbers" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "showHeaders" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "showFooters" boolean DEFAULT false NOT NULL;