CREATE TABLE "pending_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"fileSize" bigint NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "storageUsedBytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_uploads_user_expires_idx" ON "pending_uploads" USING btree ("userId","expiresAt");--> statement-breakpoint
CREATE INDEX "pending_uploads_expires_idx" ON "pending_uploads" USING btree ("expiresAt");