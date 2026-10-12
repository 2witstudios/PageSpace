ALTER TABLE "mcp_tokens" ADD COLUMN "authenticatedAt" timestamp;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "authenticationAssurance" text;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "authenticatedAt" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "authenticationAssurance" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "authenticatedAt" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "authenticationAssurance" text;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD COLUMN "authenticatedAt" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD COLUMN "authenticationAssurance" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "authenticatedAt" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "authenticationAssurance" text;