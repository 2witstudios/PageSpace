--> Written to be RE-RUNNABLE (see 0319): this runner keys applied migrations by a hash of
--> the file text, so every statement below is guarded.
--> SPEND-5 "Always my own credits": the global switch on the personal root wallet, and the
--> per-drive switch as a row in drive_spend_overrides.
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "alwaysOwnCredits" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_always_own_credits_personal_root' AND conrelid = '"wallets"'::regclass) THEN
		ALTER TABLE "wallets" ADD CONSTRAINT "wallets_always_own_credits_personal_root" CHECK (NOT "wallets"."alwaysOwnCredits" OR ("wallets"."ownerType" = 'user' AND "wallets"."subjectType" IS NULL AND "wallets"."parentWalletId" IS NULL));
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_spend_overrides" (
	"userId" text NOT NULL,
	"driveId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_spend_overrides_pkey" PRIMARY KEY("userId","driveId")
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_spend_overrides_userId_users_id_fk' AND conrelid = '"drive_spend_overrides"'::regclass) THEN
		ALTER TABLE "drive_spend_overrides" ADD CONSTRAINT "drive_spend_overrides_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_spend_overrides_driveId_drives_id_fk' AND conrelid = '"drive_spend_overrides"'::regclass) THEN
		ALTER TABLE "drive_spend_overrides" ADD CONSTRAINT "drive_spend_overrides_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
