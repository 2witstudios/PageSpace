ALTER TABLE "mcp_token_drives" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "mcp_token_drives" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
-- Backfilled MEMBER scope rows (migration 0131 + UI defaults) become inherit (NULL):
-- pre-RBAC these tokens acted as their owner, so NULL preserves shipped behavior.
-- Deliberate ADMIN rows and custom-role rows keep their explicit values.
UPDATE "mcp_token_drives" SET "role" = NULL WHERE "role" = 'MEMBER' AND "customRoleId" IS NULL;
