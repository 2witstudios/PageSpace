-- ═══════════════════════════════════════════════════════════════════════════
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
--     pointer, because its machine is meant to be a Fly Machine rather than a
--     Sprite. So the only outbox that exists, `machine_sprite_reclaims`, can
--     only ever be handed a pointer it knows how to kill.
--     NOTE, because the rest of this epic's prose describes the END state: the
--     Fly-side outbox (`app_hosting_reclaims`) and the hosting row that would
--     own a deploy box's Fly state BOTH arrive with PR #2425 and exist nowhere
--     in this schema. A `kind='deploy'` box therefore has no reclaim path at
--     all today — safe only because nothing can provision one until Phase 6,
--     which must wire the outbox in the same change.
--   * `agent_workspaces_box_no_sprite_check` — a box-BOUND session holds no
--     Sprite pointer either; it borrows the box's. This is what makes "ending
--     a box session cannot kill the box" structural rather than a flag.
--
-- `agent_workspaces_box_needs_drive_check` closes one half of the separate
-- drive-agreement invariant: a box is drive-owned, so a box-bound session must
-- have a drive. The other half (that the box belongs to THIS session's drive)
-- is enforced in `spawnAgentSession` at Phase 3 — see that constraint's
-- docblock in `schema/agent-workspaces.ts`, which records it as a SECURITY
-- criterion, not merely a correctness one.
--
-- `agent_workspaces.boxId` is ON DELETE CASCADE: a box OWNS its sessions.
-- Deleting a box takes its sessions, their panes, that tree's rev counter and
-- their shells — everything that already cascades from a session row. It does
-- NOT take chat history, because nothing links the two: `conversations` lost
-- its session column at 0256 and a pane's `targetId` is polymorphic with no
-- foreign key, so conversations are independent rows that stay reachable
-- through the cross-session past-conversations surface.
--
-- The reclaim trigger for this table ships in 0263, in the same release. A box
-- table without it would regress the orphan-billing bug `machine_sprite_reclaims`
-- exists to prevent — see that file's header.
--
-- TWO-STAGE, and only for the agent_workspaces CHECKs. `drive_boxes` is created
-- empty in this statement, so its constraint is VALID from birth with nothing
-- to scan. `agent_workspaces` is POPULATED, so its CHECKs are rewritten below
-- to ship NOT VALID (repo rule; precedent 0249/0250 expand → 0251 validate).
-- The statements `db:generate` produced are hand-amended in THIS, NEW migration
-- — never in an applied one (precedent 0250/0249/0247/0225/0222/0116).
-- ═══════════════════════════════════════════════════════════════════════════
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
ALTER TABLE "agent_workspaces" ADD CONSTRAINT "agent_workspaces_boxId_drive_boxes_id_fk" FOREIGN KEY ("boxId") REFERENCES "public"."drive_boxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_workspaces_box_id_idx" ON "agent_workspaces" USING btree ("boxId");--> statement-breakpoint
-- ── The populated-table CHECKs: STAGE 1 of 2 ────────────────────────
-- `db:generate` emits these as plain (validating) ADD CONSTRAINTs; they are
-- rewritten here to add NOT VALID and an existence guard.
--
-- NOT VALID does NOT mean unenforced. Every INSERT and every UPDATE is checked
-- from the moment this commits — it skips only the one-time verification scan
-- of the pre-existing corpus, and skipping it is what keeps a rolling deploy
-- from taking an ACCESS EXCLUSIVE lock across the whole of `agent_workspaces`.
--
-- STAGE 2 (`VALIDATE CONSTRAINT` for both, a SHARE UPDATE EXCLUSIVE lock that
-- blocks no reads or writes) must ship in the NEXT release, as its own
-- migration — deliberately NOT as a second file in this one. Every pending
-- migration runs in a SINGLE invocation, so a VALIDATE shipped alongside these
-- statements would execute seconds after them, in the same deploy, which is one
-- stage wearing two file names rather than two stages.
--
-- The scans they will run are provably empty: `boxId` is ADDED by this
-- migration, so it is NULL on every pre-existing row and both constraints are
-- satisfied vacuously by the whole corpus. The staging is for the rule and the
-- lock, not because the data is in doubt — there is no pre-validate audit to
-- write here, unlike 0251's.
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
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_workspaces_box_needs_drive_check'
      AND conrelid = 'public.agent_workspaces'::regclass
  ) THEN
    ALTER TABLE "agent_workspaces"
      ADD CONSTRAINT "agent_workspaces_box_needs_drive_check"
      CHECK ("agent_workspaces"."boxId" IS NULL OR "agent_workspaces"."driveId" IS NOT NULL)
      NOT VALID;
  END IF;
END $$;