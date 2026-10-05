CREATE TABLE "user_builtin_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"key" text NOT NULL,
	"pageId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_builtin_agents" ADD CONSTRAINT "user_builtin_agents_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_builtin_agents" ADD CONSTRAINT "user_builtin_agents_pageId_pages_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_builtin_agents_user_key_idx" ON "user_builtin_agents" USING btree ("userId","key");--> statement-breakpoint
CREATE INDEX "user_builtin_agents_page_idx" ON "user_builtin_agents" USING btree ("pageId");