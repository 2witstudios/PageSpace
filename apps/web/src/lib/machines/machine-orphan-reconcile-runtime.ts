/**
 * Default (real) IO composition for the orphan-teardown reconcile cron (Sprites
 * Idle-Cost Remediation) — binds `reconcileOrphanSprites`'s deps seam to the
 * real `machine_sessions` / `machine_branches` tables and the Sprite
 * `MachineHost`. Mirrors `machine-storage-billing.ts`'s default-deps pattern.
 *
 * Two sources, per `machine-orphan-reconcile.ts`'s module doc:
 *
 *   (A) `machine_sprite_reclaims` — the outbox. Pointers rescued by the AFTER
 *       DELETE triggers as their tracking row was cascaded away (page purged,
 *       drive deleted, account erased). No page, nothing to restore: kill.
 *
 *   (B) Tracking rows under a TRASHED page whose Sprite we still believe is live
 *       AND whose teardown was REQUESTED — a `deleteMachine` whose kill failed.
 *       The intent stamp is essential: keying on `isTrashed` alone would
 *       irreversibly destroy the disk of every Machine a user merely dragged to
 *       the trash (those Sprites just hibernate, and a restore is expected to
 *       hand the disk back). Such a Sprite is reclaimed only if its page is
 *       eventually PURGED — at which point the trigger routes it through (A).
 *
 * Both release writes are COMPARE-AND-SWAPs against (page still trashed,
 * sandboxId unchanged). A restore or a concurrent re-provision that commits
 * between our kill and our write must NOT have its live Sprite recorded as dead
 * — that would hide it from this cron and from the hard-purge guard, orphaning
 * it permanently.
 */

import { and, asc, eq, eqOrIsNull, exists, gte, isNotNull, isNull, sql } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { machineProjects } from '@pagespace/db/schema/machine-projects';
import { machineSpriteReclaims } from '@pagespace/db/schema/machine-sprite-reclaims';
import type {
  OrphanRow,
  ReconcileOrphanSpritesDeps,
} from '@pagespace/lib/services/machines/machine-orphan-reconcile';
import { MachineSpriteReplacedError } from '@pagespace/lib/services/sandbox/machine-host';
import { getMachineHostForBranches } from './machine-branches-runtime';

/** The owning page is still trashed — the precondition every release write is conditional on. */
function owningPageStillTrashed(
  pageIdColumn: typeof machineSessions.pageId | typeof machineBranches.machineId | typeof machineProjects.machineId,
) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(pages)
      .where(and(eq(pages.id, pageIdColumn), eq(pages.isTrashed, true))),
  );
}

/**
 * Most rows one run will attempt, per table.
 *
 * The reconciler kills SERIALLY, one network round-trip per row, inside a cron
 * request — so an unbounded batch (a drive with hundreds of Machines trashed at
 * once) would run until the platform's request timeout killed it mid-flight, and
 * then do the same thing again on the next tick, never draining. A cap keeps each
 * run bounded and lets the backlog drain across ticks instead: every 30 minutes,
 * another {@link MAX_CANDIDATES_PER_TABLE} Sprites die. Oldest-trashed first, so
 * the longest-billing orphans go first and nothing can be starved indefinitely.
 *
 * A capped run is LOGGED (see the cron route's `capped` flag) — a silent
 * truncation would read as "nothing left to reclaim" while Sprites kept billing.
 * Each query asks for one row MORE than it will process, because a result of
 * exactly {@link MAX_CANDIDATES_PER_TABLE} proves nothing about whether a
 * further candidate exists — reporting `capped` off that would cry wolf on every
 * exactly-full sweep.
 */
export const MAX_CANDIDATES_PER_TABLE = 200;

/** Fetch one past the cap purely to learn whether a backlog remains; it is never processed. */
const LOOKAHEAD = MAX_CANDIDATES_PER_TABLE + 1;

export const defaultReconcileOrphanSpritesDeps: ReconcileOrphanSpritesDeps = {
  async listOrphanCandidates(): Promise<{ rows: OrphanRow[]; capped: boolean }> {
    // A kill is an irreversible DESTROY, so "the page is trashed" is never enough
    // on its own — a trash is reversible, and the generic page-trash paths tear
    // down nothing. Only an explicit teardown INTENT licenses destroying a
    // tracking row's Sprite (see `machine-orphan-reconcile.ts`). Outbox rows need
    // no such check: their page is already gone.
    const [reclaimRows, sessionRows, branchRows, projectRows] = await Promise.all([
      db
        .select({
          sandboxId: machineSpriteReclaims.sandboxId,
          spriteInstanceId: machineSpriteReclaims.spriteInstanceId,
        })
        .from(machineSpriteReclaims)
        .orderBy(asc(machineSpriteReclaims.recordedAt))
        .limit(LOOKAHEAD),
      db
        .select({
          pageId: machineSessions.pageId,
          sessionKey: machineSessions.sessionKey,
          sandboxId: machineSessions.sandboxId,
          spriteInstanceId: machineSessions.spriteInstanceId,
        })
        .from(machineSessions)
        .innerJoin(pages, eq(machineSessions.pageId, pages.id))
        .where(
          and(
            eq(pages.isTrashed, true),
            isNotNull(machineSessions.teardownRequestedAt),
            // The intent must belong to THIS trash. A stale request left over from
            // an earlier delete (page restored, Sprite re-provisioned) must not
            // license destroying the VM when the Machine is later merely dragged to
            // the trash — that trash is reversible and asked for no teardown. The
            // live-Sprite write paths clear the stamp, and this is the belt to that
            // brace.
            gte(machineSessions.teardownRequestedAt, pages.trashedAt),
          ),
        )
        // Oldest-trashed first: the longest-billing orphans go first, and a
        // capped run can never starve a row indefinitely.
        .orderBy(asc(pages.trashedAt))
        .limit(LOOKAHEAD),
      db
        .select({
          pageId: machineBranches.machineId,
          id: machineBranches.id,
          sandboxId: machineBranches.sandboxId,
          spriteInstanceId: machineBranches.spriteInstanceId,
        })
        .from(machineBranches)
        .innerJoin(pages, eq(machineBranches.machineId, pages.id))
        // spriteTornDownAt IS NULL — an already-reclaimed branch row is pure
        // config now, not a live Sprite, so it is not a candidate.
        .where(
          and(
            eq(pages.isTrashed, true),
            isNull(machineBranches.spriteTornDownAt),
            isNotNull(machineBranches.teardownRequestedAt),
            // See the session query: a stale intent must never license a kill on a
            // LATER, reversible trash.
            gte(machineBranches.teardownRequestedAt, pages.trashedAt),
          ),
        )
        .orderBy(asc(pages.trashedAt))
        .limit(LOOKAHEAD),
      db
        .select({
          pageId: machineProjects.machineId,
          id: machineProjects.id,
          sandboxId: machineProjects.sandboxId,
          spriteInstanceId: machineProjects.spriteInstanceId,
        })
        .from(machineProjects)
        .innerJoin(pages, eq(machineProjects.machineId, pages.id))
        // sandboxId IS NOT NULL — an UNPROMOTED project has no Sprite of its
        // own (it is a checkout on the machine's Sprite); spriteTornDownAt IS
        // NULL for the same reason as branches.
        .where(
          and(
            eq(pages.isTrashed, true),
            isNotNull(machineProjects.sandboxId),
            isNull(machineProjects.spriteTornDownAt),
            isNotNull(machineProjects.teardownRequestedAt),
            // See the session query: a stale intent must never license a kill on a
            // LATER, reversible trash.
            gte(machineProjects.teardownRequestedAt, pages.trashedAt),
          ),
        )
        .orderBy(asc(pages.trashedAt))
        .limit(LOOKAHEAD),
    ]);

    return {
      rows: [
        // Outbox first: these Sprites have NO pointer left anywhere else, so they
        // are the ones that bill forever if this run does not get to them.
        ...reclaimRows.slice(0, MAX_CANDIDATES_PER_TABLE).map((row): OrphanRow => ({ kind: 'reclaim', ...row })),
        ...sessionRows.slice(0, MAX_CANDIDATES_PER_TABLE).map((row): OrphanRow => ({ kind: 'session', ...row })),
        ...branchRows.slice(0, MAX_CANDIDATES_PER_TABLE).map((row): OrphanRow => ({ kind: 'branch', ...row })),
        ...projectRows
          .slice(0, MAX_CANDIDATES_PER_TABLE)
          // The query's isNotNull(sandboxId) guarantees this; the filter narrows the type.
          .flatMap((row): OrphanRow[] =>
            row.sandboxId ? [{ kind: 'project', ...row, sandboxId: row.sandboxId }] : [],
          ),
      ],
      // The lookahead row is what makes this honest: a source that came back
      // exactly full might have had nothing more to give, and reporting a backlog
      // off that would cry wolf every time. Only a row BEYOND the cap proves one.
      capped:
        reclaimRows.length > MAX_CANDIDATES_PER_TABLE ||
        sessionRows.length > MAX_CANDIDATES_PER_TABLE ||
        branchRows.length > MAX_CANDIDATES_PER_TABLE ||
        projectRows.length > MAX_CANDIDATES_PER_TABLE,
    };
  },

  async isStillTrashed(pageId) {
    const [row] = await db
      .select({ isTrashed: pages.isTrashed })
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);
    // A page that has vanished entirely (hard-purged mid-run) is not restorable
    // — killing its Sprite is exactly what we want, so treat it as trashed.
    return row?.isTrashed ?? true;
  },

  async killSprite({ sandboxId, spriteInstanceId }) {
    try {
      const host = await getMachineHostForBranches();
      // Idempotent: an already-destroyed Sprite is a successful kill.
      await host.kill({ machineId: sandboxId, expectedInstanceId: spriteInstanceId ?? undefined });
      return { ok: true };
    } catch (error) {
      // A DIFFERENT VM holds this name now, so the instance we were tracking is
      // already GONE — which is exactly the outcome we wanted. Treat it as SUCCESS,
      // so the outbox row / tracking row is released. Treating it as a failure
      // instead would retry this row forever (growing `attempts`) against a target
      // that no longer exists, and could never drop the pointer. The live newcomer
      // has its OWN fresh tracking row, so releasing ours never orphans it.
      if (error instanceof MachineSpriteReplacedError) return { ok: true };
      // Any other failure (unreachable host, 5xx) genuinely leaves our target's
      // fate unknown — report it so the row is kept and retried next run.
      return { ok: false, error };
    }
  },

  async releaseSessionRow({ sessionKey, sandboxId, spriteInstanceId }) {
    // One transaction: the AFTER DELETE trigger rescues this row's sandboxId into
    // the outbox as it goes (it cannot know why the row is going). Here the Sprite
    // is already CONFIRMED dead, so the rescued pointer would only cost a
    // redundant kill next tick — drop it with the row. A rollback keeps the
    // pointer, which is the safe way to be wrong.
    return db.transaction(async (tx) => {
      const released = await tx
        .delete(machineSessions)
        .where(
          and(
            eq(machineSessions.sessionKey, sessionKey),
            eq(machineSessions.sandboxId, sandboxId),
            // The INSTANCE, not just the name: a replacement Sprite provisioned
            // under this same session key would otherwise pass the check, and we
            // would delete the only pointer to a LIVE VM.
            eqOrIsNull(machineSessions.spriteInstanceId, spriteInstanceId),
            owningPageStillTrashed(machineSessions.pageId),
          ),
        )
        .returning({ id: machineSessions.id });
      if (released.length === 0) return false;
      await tx.delete(machineSpriteReclaims).where(eq(machineSpriteReclaims.sandboxId, sandboxId));
      return true;
    });
  },

  async releaseReclaim(sandboxId) {
    // The Sprite is confirmed gone, so the rescued pointer has done its job.
    await db.delete(machineSpriteReclaims).where(eq(machineSpriteReclaims.sandboxId, sandboxId));
  },

  async noteReclaimFailure({ sandboxId, error }) {
    // Kept, never dropped — the outbox row is the last pointer to this Sprite.
    // The attempt count is the health signal: a row with a high `attempts` is a
    // VM that cannot be killed and is still billing.
    await db
      .update(machineSpriteReclaims)
      .set({
        attempts: sql`${machineSpriteReclaims.attempts} + 1`,
        lastAttemptAt: new Date(),
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(machineSpriteReclaims.sandboxId, sandboxId));
  },

  async markBranchTornDown({ id, sandboxId, spriteInstanceId }) {
    // Stamped, never deleted: the row is the user's branch-terminal config, and
    // its branch-scoped machine_agent_terminals FK-cascade off it.
    const marked = await db
      .update(machineBranches)
      .set({ spriteTornDownAt: new Date() })
      .where(
        and(
          eq(machineBranches.id, id),
          eq(machineBranches.sandboxId, sandboxId),
          // The INSTANCE — stamping a row that a re-provision has already pointed
          // at a LIVE Sprite would hide that VM from this cron forever.
          eqOrIsNull(machineBranches.spriteInstanceId, spriteInstanceId),
          owningPageStillTrashed(machineBranches.machineId),
        ),
      )
      .returning({ id: machineBranches.id });
    return marked.length > 0;
  },

  async markProjectTornDown({ id, sandboxId, spriteInstanceId }) {
    // Identical contract to markBranchTornDown: the row is re-creatable config
    // (name + repoUrl + sessionKey re-provision and re-clone), and a
    // re-promotion that raced us must not have its live Sprite marked dead.
    const marked = await db
      .update(machineProjects)
      .set({ spriteTornDownAt: new Date() })
      .where(
        and(
          eq(machineProjects.id, id),
          eq(machineProjects.sandboxId, sandboxId),
          eqOrIsNull(machineProjects.spriteInstanceId, spriteInstanceId),
          owningPageStillTrashed(machineProjects.machineId),
        ),
      )
      .returning({ id: machineProjects.id });
    return marked.length > 0;
  },
};
