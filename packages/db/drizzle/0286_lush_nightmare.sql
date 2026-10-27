CREATE TABLE "dev_preview_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"holderKind" text NOT NULL,
	"holderId" text NOT NULL,
	"userId" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"cookieExpiresAt" timestamp NOT NULL,
	"consumedAt" timestamp,
	"createdAt" timestamp NOT NULL,
	CONSTRAINT "dev_preview_grants_holder_kind_check" CHECK ("dev_preview_grants"."holderKind" IN ('workspace', 'env'))
);
--> statement-breakpoint
ALTER TABLE "dev_preview_grants" ADD CONSTRAINT "dev_preview_grants_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dev_preview_grants_expires_at_idx" ON "dev_preview_grants" USING btree ("expiresAt");