CREATE TABLE IF NOT EXISTS "mcp_token_drives" (
	"id" text PRIMARY KEY NOT NULL,
	"tokenId" text NOT NULL,
	"driveId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "isScoped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_token_drives" ADD CONSTRAINT "mcp_token_drives_tokenId_mcp_tokens_id_fk" FOREIGN KEY ("tokenId") REFERENCES "public"."mcp_tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_token_drives" ADD CONSTRAINT "mcp_token_drives_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_token_drives_token_id_idx" ON "mcp_token_drives" USING btree ("tokenId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_token_drives_drive_id_idx" ON "mcp_token_drives" USING btree ("driveId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_token_drives_token_drive_unique" ON "mcp_token_drives" USING btree ("tokenId","driveId");