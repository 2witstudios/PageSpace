-- MCP Token Drive Scopes
-- Junction table for MCP token drive scoping
-- If a token has no entries here, it has access to ALL user's drives (backward compatible)
-- If a token has entries here, it ONLY has access to those specific drives

-- Add isScoped column to mcp_tokens (fail-closed security)
-- When isScoped=true and driveScopes is empty, deny all access (prevents privilege escalation on drive deletion)
ALTER TABLE "mcp_tokens" ADD COLUMN IF NOT EXISTS "isScoped" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "mcp_token_drives" (
  "id" text PRIMARY KEY NOT NULL,
  "tokenId" text NOT NULL,
  "driveId" text NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

-- Add foreign key constraints
DO $$ BEGIN
  ALTER TABLE "mcp_token_drives" ADD CONSTRAINT "mcp_token_drives_tokenId_mcp_tokens_id_fk" FOREIGN KEY ("tokenId") REFERENCES "public"."mcp_tokens"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "mcp_token_drives" ADD CONSTRAINT "mcp_token_drives_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add indexes
CREATE INDEX IF NOT EXISTS "mcp_token_drives_token_id_idx" ON "mcp_token_drives" USING btree ("tokenId");
CREATE INDEX IF NOT EXISTS "mcp_token_drives_drive_id_idx" ON "mcp_token_drives" USING btree ("driveId");
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_token_drives_token_drive_unique" ON "mcp_token_drives" USING btree ("tokenId", "driveId");
