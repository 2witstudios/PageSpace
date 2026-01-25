DO $$ BEGIN
 CREATE TYPE "public"."security_event_type" AS ENUM('auth.login.success', 'auth.login.failure', 'auth.logout', 'auth.token.created', 'auth.token.revoked', 'auth.token.refreshed', 'auth.password.changed', 'auth.password.reset.requested', 'auth.password.reset.completed', 'auth.mfa.enabled', 'auth.mfa.disabled', 'auth.mfa.challenged', 'auth.mfa.verified', 'auth.session.created', 'auth.session.revoked', 'auth.device.registered', 'auth.device.revoked', 'authz.access.granted', 'authz.access.denied', 'authz.permission.granted', 'authz.permission.revoked', 'authz.role.assigned', 'authz.role.removed', 'data.read', 'data.write', 'data.delete', 'data.export', 'data.share', 'admin.user.created', 'admin.user.suspended', 'admin.user.reactivated', 'admin.user.deleted', 'admin.settings.changed', 'security.anomaly.detected', 'security.rate.limited', 'security.brute.force.detected', 'security.suspicious.activity');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" "security_event_type" NOT NULL,
	"user_id" text,
	"session_id" text,
	"service_id" text,
	"resource_type" text,
	"resource_id" text,
	"ip_address" text,
	"user_agent" text,
	"geo_location" text,
	"details" jsonb,
	"risk_score" real,
	"anomaly_flags" text[],
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"previous_hash" text,
	"event_hash" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_audit_log" ADD CONSTRAINT "security_audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_timestamp" ON "security_audit_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_user_timestamp" ON "security_audit_log" USING btree ("user_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_event_type" ON "security_audit_log" USING btree ("event_type","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_resource" ON "security_audit_log" USING btree ("resource_type","resource_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_ip" ON "security_audit_log" USING btree ("ip_address","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_event_hash" ON "security_audit_log" USING btree ("event_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_risk_score" ON "security_audit_log" USING btree ("risk_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_security_audit_session" ON "security_audit_log" USING btree ("session_id","timestamp");