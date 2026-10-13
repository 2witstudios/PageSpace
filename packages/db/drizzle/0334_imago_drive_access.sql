CREATE TABLE "imago_drive_access" (
	"userId" text NOT NULL,
	"driveId" text NOT NULL,
	"enabled" boolean NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "imago_drive_access_userId_driveId_pk" PRIMARY KEY("userId","driveId")
);
--> statement-breakpoint
ALTER TABLE "imago_drive_access" ADD CONSTRAINT "imago_drive_access_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imago_drive_access" ADD CONSTRAINT "imago_drive_access_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imago_drive_access_drive_idx" ON "imago_drive_access" USING btree ("driveId");