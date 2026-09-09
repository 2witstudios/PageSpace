-- ═══════════════════════════════════════════════════════════════════════════
-- Epic "Deliberate Per-Drive Environments", Phase 1 — the schema foundation.
-- SHIPS DARK: nothing writes `drive_envs` until Phase 2's CRUD lands, and no
-- session carries an `envId` until Phase 3.
--
-- An env is a PERSISTENT, drive-owned machine that sessions can be spawned
-- inside; ephemeral per-session sandboxes stay the default and are unchanged.
--
-- The invariant the whole split rests on is "a Sprite belongs to exactly ONE
-- row": `agent_workspaces_env_no_sprite_check` forbids an env-BOUND session
-- from holding a Sprite pointer, because it borrows the env's. That is what
-- makes "ending an env session cannot kill the env" structural rather than a
-- flag — the planner sees `sandboxId IS NULL` and stamps `endedAt`.
--
-- NO KIND COLUMN, deliberately. An earlier cut carried a `drive_env_kind` enum
-- (dev|staging|deploy) and a CHECK partitioning Sprite pointers by it. Both
-- are gone: dev/staging/prod are USE CASES a user expresses by NAMING an env,
-- not types the schema needs, and an enum would force every new use case
-- through a migration. Every env is Sprite-backed uniformly, so the Sprite
-- columns are unconditional and `machine_sprite_reclaims` is the only outbox
-- this table can feed. The Fly serving tier attaches later as a
-- `published_apps.envId` hosting row pointing AT an env; it never puts Fly
-- pointers on the env row.
--
-- `agent_workspaces_env_needs_drive_check` closes one half of the
-- drive-agreement invariant: an env is drive-owned, so an env-bound session
-- must have a drive. The other half (that the env belongs to THIS session's
-- drive) is a Phase 3 acceptance criterion on `spawnAgentSession` — see that
-- constraint's docblock in `schema/agent-workspaces.ts`, which records it as a
-- SECURITY criterion and notes a composite FK could now enforce it outright.
--
-- `agent_workspaces.envId` is ON DELETE CASCADE: an env OWNS its sessions.
-- Deleting an env takes its sessions, their panes, that tree's rev counter and
-- their shells — everything that already cascades from a session row. It does
-- NOT take chat history, because nothing links the two: `conversations` lost
-- its session column at 0256 and a pane's `targetId` is polymorphic with no
-- foreign key, so conversations are independent rows that stay reachable
-- through the cross-session past-conversations surface.
--
-- The reclaim trigger for this table ships in 0263, in the same release. An
-- env table without it would regress the orphan-billing bug
-- `machine_sprite_reclaims` exists to prevent — see that file's header.
--
-- TWO-STAGE, and only for the agent_workspaces CHECKs. `agent_workspaces` is
-- POPULATED, so both CHECKs are rewritten below to ship NOT VALID (repo rule;
-- precedent 0249/0250 expand → 0251 validate). The statements `db:generate`
-- produced are hand-amended in THIS, NEW migration — never in an applied one
-- (precedent 0250/0249/0247/0225/0222/0116).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE "drive_envs" (
	"id" text PRIMARY KEY NOT NULL,
	"driveId" text NOT NULL,
	"name" text NOT NULL,
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
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_workspaces" ADD COLUMN "envId" text;--> statement-breakpoint
ALTER TABLE "drive_envs" ADD CONSTRAINT "drive_envs_driveId_drives_id_fk" FOREIGN KEY ("driveId") REFERENCES "public"."drives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_envs" ADD CONSTRAINT "drive_envs_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_envs_drive_id_idx" ON "drive_envs" USING btree ("driveId");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_envs_drive_name_idx" ON "drive_envs" USING btree ("driveId","name");--> statement-breakpoint
CREATE INDEX "drive_envs_live_sprite_idx" ON "drive_envs" USING btree ("sandboxId","spriteTornDownAt") WHERE "drive_envs"."sandboxId" IS NOT NULL AND "drive_envs"."spriteTornDownAt" IS NULL;--> statement-breakpoint
ALTER TABLE "agent_workspaces" ADD CONSTRAINT "agent_workspaces_envId_drive_envs_id_fk" FOREIGN KEY ("envId") REFERENCES "public"."drive_envs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_workspaces_env_id_idx" ON "agent_workspaces" USING btree ("envId");--> statement-breakpoint
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
-- The scans they will run are provably empty: `envId` is ADDED by this
-- migration, so it is NULL on every pre-existing row and both constraints are
-- satisfied vacuously by the whole corpus. The staging is for the rule and the
-- lock, not because the data is in doubt — there is no pre-validate audit to
-- write here, unlike 0251's.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_workspaces_env_no_sprite_check'
      AND conrelid = 'public.agent_workspaces'::regclass
  ) THEN
    ALTER TABLE "agent_workspaces"
      ADD CONSTRAINT "agent_workspaces_env_no_sprite_check"
      CHECK ("agent_workspaces"."envId" IS NULL OR ("agent_workspaces"."sandboxId" IS NULL AND "agent_workspaces"."spriteKey" IS NULL AND "agent_workspaces"."spriteInstanceId" IS NULL))
      NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_workspaces_env_needs_drive_check'
      AND conrelid = 'public.agent_workspaces'::regclass
  ) THEN
    ALTER TABLE "agent_workspaces"
      ADD CONSTRAINT "agent_workspaces_env_needs_drive_check"
      CHECK ("agent_workspaces"."envId" IS NULL OR "agent_workspaces"."driveId" IS NOT NULL)
      NOT VALID;
  END IF;
END $$;