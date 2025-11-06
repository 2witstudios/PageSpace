-- GitHub Integration Tables Migration

-- Create github_connections table
CREATE TABLE IF NOT EXISTS "github_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"githubUserId" text NOT NULL,
	"githubUsername" text NOT NULL,
	"githubEmail" text,
	"githubAvatarUrl" text,
	"encryptedAccessToken" text NOT NULL,
	"tokenType" text DEFAULT 'Bearer',
	"scope" text,
	"lastUsed" timestamp,
	"expiresAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp
);
--> statement-breakpoint

-- Create github_repositories table
CREATE TABLE IF NOT EXISTS "github_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"connectionId" text NOT NULL,
	"githubRepoId" integer NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"fullName" text NOT NULL,
	"description" text,
	"isPrivate" boolean DEFAULT false NOT NULL,
	"defaultBranch" text DEFAULT 'main' NOT NULL,
	"language" text,
	"htmlUrl" text NOT NULL,
	"cloneUrl" text NOT NULL,
	"stargazersCount" integer DEFAULT 0,
	"forksCount" integer DEFAULT 0,
	"openIssuesCount" integer DEFAULT 0,
	"lastSyncedAt" timestamp,
	"syncError" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"branches" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Create github_code_embeds table
CREATE TABLE IF NOT EXISTS "github_code_embeds" (
	"id" text PRIMARY KEY NOT NULL,
	"repositoryId" text NOT NULL,
	"filePath" text NOT NULL,
	"branch" text NOT NULL,
	"startLine" integer,
	"endLine" integer,
	"content" text,
	"language" text,
	"fileSize" integer,
	"commitSha" text,
	"lastFetchedAt" timestamp,
	"fetchError" text,
	"showLineNumbers" boolean DEFAULT true NOT NULL,
	"highlightLines" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Create github_search_cache table
CREATE TABLE IF NOT EXISTS "github_search_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"query" text NOT NULL,
	"repositoryIds" jsonb,
	"results" jsonb,
	"resultCount" integer DEFAULT 0,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Add foreign key constraints
DO $$ BEGIN
 ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_connectionId_github_connections_id_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."github_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "github_code_embeds" ADD CONSTRAINT "github_code_embeds_repositoryId_github_repositories_id_fk" FOREIGN KEY ("repositoryId") REFERENCES "public"."github_repositories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "github_search_cache" ADD CONSTRAINT "github_search_cache_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Create indexes
CREATE INDEX IF NOT EXISTS "github_connections_user_id_idx" ON "github_connections" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_connections_github_user_id_idx" ON "github_connections" USING btree ("githubUserId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_repositories_drive_id_idx" ON "github_repositories" USING btree ("driveId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_repositories_connection_id_idx" ON "github_repositories" USING btree ("connectionId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_repositories_github_repo_id_idx" ON "github_repositories" USING btree ("githubRepoId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_repositories_full_name_idx" ON "github_repositories" USING btree ("fullName");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_code_embeds_repository_id_idx" ON "github_code_embeds" USING btree ("repositoryId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_code_embeds_file_path_idx" ON "github_code_embeds" USING btree ("filePath");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_code_embeds_branch_idx" ON "github_code_embeds" USING btree ("branch");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_search_cache_drive_id_idx" ON "github_search_cache" USING btree ("driveId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_search_cache_query_idx" ON "github_search_cache" USING btree ("query");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_search_cache_expires_at_idx" ON "github_search_cache" USING btree ("expiresAt");
