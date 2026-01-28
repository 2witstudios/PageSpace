ALTER TYPE "AuthProvider" ADD VALUE 'apple';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "appleId" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_appleId_unique" UNIQUE("appleId");