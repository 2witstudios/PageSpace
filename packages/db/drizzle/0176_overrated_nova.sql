DO $$ BEGIN
 CREATE TYPE "public"."OAuthClientType" AS ENUM('public', 'confidential');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tokenHash" text NOT NULL,
	"tokenPrefix" text NOT NULL,
	"familyId" text NOT NULL,
	"clientId" text NOT NULL,
	"userId" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"tokenVersion" integer NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"revokedAt" timestamp,
	"revokedReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_access_tokens_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"codeHash" text NOT NULL,
	"codePrefix" text NOT NULL,
	"clientId" text NOT NULL,
	"userId" text NOT NULL,
	"redirectUri" text NOT NULL,
	"codeChallenge" text NOT NULL,
	"codeChallengeMethod" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"consumedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_codes_codeHash_unique" UNIQUE("codeHash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"name" text NOT NULL,
	"clientType" "OAuthClientType" NOT NULL,
	"redirectUris" jsonb NOT NULL,
	"isFirstParty" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"disabledAt" timestamp,
	CONSTRAINT "oauth_clients_clientId_unique" UNIQUE("clientId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"deviceCodeHash" text NOT NULL,
	"deviceCodePrefix" text NOT NULL,
	"userCodeHash" text NOT NULL,
	"userCodePrefix" text NOT NULL,
	"clientId" text NOT NULL,
	"userId" text,
	"scopes" jsonb NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"approvedAt" timestamp,
	"deniedAt" timestamp,
	"lastPolledAt" timestamp,
	"pollIntervalSeconds" integer DEFAULT 5 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_device_codes_deviceCodeHash_unique" UNIQUE("deviceCodeHash"),
	CONSTRAINT "oauth_device_codes_userCodeHash_unique" UNIQUE("userCodeHash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tokenHash" text NOT NULL,
	"tokenPrefix" text NOT NULL,
	"familyId" text NOT NULL,
	"clientId" text NOT NULL,
	"userId" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"tokenVersion" integer NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"familyExpiresAt" timestamp NOT NULL,
	"replacedByTokenId" text,
	"revokedAt" timestamp,
	"revokedReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_clientId_oauth_clients_id_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_clientId_oauth_clients_id_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_clientId_oauth_clients_id_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_clientId_oauth_clients_id_fk" FOREIGN KEY ("clientId") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_family_id_idx" ON "oauth_access_tokens" USING btree ("familyId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_user_id_idx" ON "oauth_access_tokens" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_client_id_idx" ON "oauth_access_tokens" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_token_hash_idx" ON "oauth_access_tokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_expires_at_idx" ON "oauth_access_tokens" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_authorization_codes_client_id_idx" ON "oauth_authorization_codes" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_authorization_codes_user_id_idx" ON "oauth_authorization_codes" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_authorization_codes_code_hash_idx" ON "oauth_authorization_codes" USING btree ("codeHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_authorization_codes_expires_at_idx" ON "oauth_authorization_codes" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_clients_client_id_idx" ON "oauth_clients" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_device_codes_client_id_idx" ON "oauth_device_codes" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_device_codes_user_id_idx" ON "oauth_device_codes" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_device_codes_device_code_hash_idx" ON "oauth_device_codes" USING btree ("deviceCodeHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_device_codes_user_code_hash_idx" ON "oauth_device_codes" USING btree ("userCodeHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_device_codes_expires_at_idx" ON "oauth_device_codes" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_family_id_idx" ON "oauth_refresh_tokens" USING btree ("familyId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_user_id_idx" ON "oauth_refresh_tokens" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_client_id_idx" ON "oauth_refresh_tokens" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_token_hash_idx" ON "oauth_refresh_tokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_tokens_expires_at_idx" ON "oauth_refresh_tokens" USING btree ("expiresAt");