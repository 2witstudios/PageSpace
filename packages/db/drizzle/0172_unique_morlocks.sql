ALTER TABLE "drives" ADD COLUMN "publish_default_og_image_url" text;--> statement-breakpoint
ALTER TABLE "published_pages" ADD COLUMN "publish_title" text;--> statement-breakpoint
ALTER TABLE "published_pages" ADD COLUMN "publish_description" text;--> statement-breakpoint
ALTER TABLE "published_pages" ADD COLUMN "publish_og_image_url" text;--> statement-breakpoint
ALTER TABLE "published_pages" ADD COLUMN "noindex" boolean DEFAULT false NOT NULL;