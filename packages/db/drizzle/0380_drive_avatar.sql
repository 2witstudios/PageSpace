ALTER TABLE "drives" ADD COLUMN "avatarUrl" text;--> statement-breakpoint
ALTER TABLE "drives" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "drives" ADD CONSTRAINT "drives_avatar_url_chk" CHECK ("drives"."avatarUrl" IS NULL OR "drives"."avatarUrl" ~ ('^/api/drives/' || "drives"."id" || '/avatar/avatar-[a-z0-9]{1,32}\.(png|jpg|gif|webp)$'));--> statement-breakpoint
ALTER TABLE "drives" ADD CONSTRAINT "drives_color_chk" CHECK ("drives"."color" IS NULL OR "drives"."color" IN ('slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink'));