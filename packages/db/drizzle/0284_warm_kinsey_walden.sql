CREATE TABLE "dev_preview_services" (
	"id" text PRIMARY KEY NOT NULL,
	"workspaceId" text,
	"envId" text,
	"spriteInstanceId" text NOT NULL,
	"sandboxId" text NOT NULL,
	"targetPort" integer NOT NULL,
	"relayServiceName" text,
	"detectedAt" timestamp NOT NULL,
	"stoppedByUserAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "dev_preview_services_one_holder_check" CHECK (("dev_preview_services"."workspaceId" IS NULL) <> ("dev_preview_services"."envId" IS NULL)),
	CONSTRAINT "dev_preview_services_target_port_range_check" CHECK ("dev_preview_services"."targetPort" BETWEEN 1 AND 65535),
	CONSTRAINT "dev_preview_services_relay_iff_not_8080_check" CHECK (("dev_preview_services"."targetPort" = 8080) = ("dev_preview_services"."relayServiceName" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_workspaceId_agent_workspaces_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."agent_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_preview_services" ADD CONSTRAINT "dev_preview_services_envId_drive_envs_id_fk" FOREIGN KEY ("envId") REFERENCES "public"."drive_envs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dev_preview_services_sprite_instance_idx" ON "dev_preview_services" USING btree ("spriteInstanceId");--> statement-breakpoint
CREATE UNIQUE INDEX "dev_preview_services_workspace_id_idx" ON "dev_preview_services" USING btree ("workspaceId") WHERE "dev_preview_services"."workspaceId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dev_preview_services_env_id_idx" ON "dev_preview_services" USING btree ("envId") WHERE "dev_preview_services"."envId" IS NOT NULL;