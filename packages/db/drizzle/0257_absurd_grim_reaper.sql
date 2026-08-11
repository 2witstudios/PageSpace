CREATE TABLE "personalization_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"field" text NOT NULL,
	"claim" text NOT NULL,
	"claimKey" text NOT NULL,
	"evidence" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"firstSeenAt" timestamp DEFAULT now() NOT NULL,
	"lastSeenAt" timestamp DEFAULT now() NOT NULL,
	"promotedAt" timestamp,
	"rejectedAt" timestamp,
	CONSTRAINT "personalization_candidates_field_chk" CHECK ("personalization_candidates"."field" IN ('bio', 'writingStyle', 'rules'))
);
--> statement-breakpoint
ALTER TABLE "user_personalization" ADD COLUMN "memoryFolderId" text;--> statement-breakpoint
ALTER TABLE "user_personalization" ADD COLUMN "bioPageId" text;--> statement-breakpoint
ALTER TABLE "user_personalization" ADD COLUMN "writingStylePageId" text;--> statement-breakpoint
ALTER TABLE "user_personalization" ADD COLUMN "rulesPageId" text;--> statement-breakpoint
ALTER TABLE "personalization_candidates" ADD CONSTRAINT "personalization_candidates_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personalization_candidates_user_field_claim_idx" ON "personalization_candidates" USING btree ("userId","field","claimKey");--> statement-breakpoint
ALTER TABLE "user_personalization" ADD CONSTRAINT "user_personalization_memoryFolderId_pages_id_fk" FOREIGN KEY ("memoryFolderId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_personalization" ADD CONSTRAINT "user_personalization_bioPageId_pages_id_fk" FOREIGN KEY ("bioPageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_personalization" ADD CONSTRAINT "user_personalization_writingStylePageId_pages_id_fk" FOREIGN KEY ("writingStylePageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_personalization" ADD CONSTRAINT "user_personalization_rulesPageId_pages_id_fk" FOREIGN KEY ("rulesPageId") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;