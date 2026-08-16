-- ══════════════════════════════════════════════════════════════════════════
-- Epic "Deliberate Per-Drive Boxes", Phase 1 — the schema foundation. SHIPS
-- DARK: nothing writes `drive_boxes` until Phase 2's CRUD lands, and no
-- session carries a `boxId` until Phase 3.
--
-- A box is a PERSISTENT, drive-owned machine that sessions can be spawned
-- inside; ephemeral per-session sandboxes stay the default and are unchanged.
-- The invariant the whole split rests on is "a Sprite belongs to exactly ONE
-- row", and it is stated twice here, from both sides:
--
--   * `drive_boxes_sprite_kind_check` — a `kind='deploy'` box holds no Sprite
--     pointer (its machine is a Fly Machine, tracked on its hosting row), so
--     the two reclaim outboxes stay partitioned: Sprite names can only ever
--     reach `machine_sprite_reclaims`, Fly app names only `app_hosting_reclaims`.
--   * `agent_workspaces_box_no_sprite_check` — a box-BOUND session holds no
--     Sprite pointer either; it borrows the box's. This is what makes "ending
--     a box session cannot kill the box" structural rather than a flag.
--
-- The reclaim trigger for this table ships in 0263, in the same release. A box
-- table without it would regress the orphan-billing bug `machine_sprite_reclaims`
-- exists to prevent — see that file's header.
--
-- TWO-STAGE, and only for the second CHECK. `drive_boxes` is created empty in
-- this statement, so its constraint is VALID from birth with nothing to scan.
-- `agent_workspaces` is POPULATED, so its CHECK is rewritten below to ship
-- NOT VALID (repo rule; precedent 0249/0250 expand → 0251 validate). The
-- statements `db:generate` produced are hand-amended in THIS, NEW migration —
-- never in an applied one (precedent 0250/0249/0247/0225/0222/0116).
-- ══════════════════════════════════════════════════════════════════════════
CREATE TYPE "public"."drive_box_kind" AS ENUM('dev', 'staging', 'deploy');--> statement-breakpoint
CREATE TABLE "drive_boxes" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"name" text NOT NULL,
	"kind" "drive_box_kind" NOT NULL,
	"createdBy" text,
	"spriteKey" text,
	"sandboxId" text,
	"spriteInstanceId" text,
	"egressPolicyToken" text,
	"teardownRequestedAt" timestamp,
	"spriteTornDownAt" timestamp,
	"storageLastBilledAt" timestamp DEFAULT now() NOT NULL,
	"storageMeasuredBytes" bigint,
	"storageMeasuredAt" timestamp,
	"lastActiveAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "drive_boxes_sprite_kind_check" CHECK ("drive_boxes"."kind" IN ('dev', 'staging') OR ("drive_boxes"."sandboxId" IS NULL AND "drive_boxes"."spriteKey" IS NULL AND "drive_boxes"."spriteInstanceId" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_workspaces" ADD COLUMN "boxId" text;--> statement-breakpoint
ALTER TABLE "drive_boxes" ADD CONSTRAINT "drive_boxes_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_boxes" ADD CONSTRAINT "drive_boxes_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_boxes_drive_id_idx" ON "drive_boxes" USING btree ("driveId");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_boxes_drive_name_idx" ON "drive_boxes" USING btree ("driveId","name");--> statement-breakpoint
CREATE INDEX "drive_boxes_live_sprite_idx" ON "drive_boxes" USING btree ("sandboxId","spriteTornDownAt") WHERE "drive_boxes"."sandboxId" IS NOT NULL AND "drive_boxes"."spriteTornDownAt" IS NULL;--> statement-breakpoint
ALTER TABLE "agent_workspaces" ADD CONSTRAINT "agent_workspaces_boxId_drive_boxes_id_fk" FOREIGN KEY ("boxId") REFERENCES "public"."drive_boxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_workspaces_box_id_idx" ON "agent_workspaces" USING btree ("boxId");--> statement-breakpoint
-- ── The populated-table CHECK: STAGE 1 of 2 ───────────────────────────────
-- `db:generate` emits this as a plain (validating) ADD CONSTRAINT; it is
-- rewritten here to add NOT VALID and an existence guard.
--
-- NOT VALID does NOT mean unenforced. Every INSERT and every UPDATE is checked
-- from the moment this commits — it skips only the one-time verification scan
-- of the pre-existing corpus, and skipping it is what keeps a rolling deploy
-- from taking an ACCESS EXCLUSIVE lock across the whole of `agent_workspaces`.
--
-- STAGE 2 (`ALTER TABLE "agent_workspaces" VALIDATE CONSTRAINT
-- "agent_workspaces_box_no_sprite_check"`, a SHARE UPDATE EXCLUSIVE lock that
-- blocks no reads or writes) must ship in the NEXT release, as its own
-- migration — deliberately NOT as a second file in this one. Every pending
-- migration runs in a SINGLE invocation, so a VALIDATE shipped alongside this
-- statement would execute seconds after it, in the same deploy, which is one
-- stage wearing two file names rather than two stages.
--
-- The scan it will run is provably empty: `boxId` is ADDED by this migration,
-- so it is NULL on every pre-existing row and the constraint is satisfied
-- vacuously by the whole corpus. The staging is for the rule and the lock, not
-- because the data is in doubt — there is no pre-validate audit to write here,
-- unlike 0251's.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_workspaces_box_no_sprite_check'
      AND conrelid = 'public.agent_workspaces'::regclass
  ) THEN
    ALTER TABLE "agent_workspaces"
      ADD CONSTRAINT "agent_workspaces_box_no_sprite_check"
      CHECK ("agent_workspaces"."boxId" IS NULL OR ("agent_workspaces"."sandboxId" IS NULL AND "agent_workspaces"."spriteKey" IS NULL AND "agent_workspaces"."spriteInstanceId" IS NULL))
      NOT VALID;
  END IF;
END $$;