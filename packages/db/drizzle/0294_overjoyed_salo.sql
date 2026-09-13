ALTER TABLE "oauth_clients" ADD COLUMN "allowedGrantTypes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "allowedScopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "ownerUserId" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "logoUrl" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "homepageUrl" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "updatedAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_ownerUserId_users_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_clients_owner_user_id_idx" ON "oauth_clients" USING btree ("ownerUserId");