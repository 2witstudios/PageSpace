CREATE TABLE "org_audit_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"orgId" text NOT NULL,
	"eventType" text NOT NULL,
	"actorId" text,
	"resourceType" text NOT NULL,
	"resourceId" text NOT NULL,
	"driveId" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastError" text,
	"nextAttemptAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL,
	"createdAt" timestamp DEFAULT (now() at time zone 'utc') NOT NULL
);
--> statement-breakpoint
CREATE INDEX "org_audit_outbox_next_attempt_idx" ON "org_audit_outbox" USING btree ("nextAttemptAt");