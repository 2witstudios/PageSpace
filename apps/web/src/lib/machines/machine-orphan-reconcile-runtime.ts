/**
 * Default (real) IO composition for the orphan-teardown reconcile cron (Sprites
 * Idle-Cost Remediation) — binds `reconcileOrphanSprites`'s deps seam to the
 * real `machine_sessions` / `machine_branches` tables and the Sprite
 * `MachineHost`. Mirrors `machine-storage-billing.ts`'s default-deps pattern.
 *
 * The candidate query is the design. Join each tracking table to `pages`, keep
 * the rows whose owning page `isTrashed` AND whose Sprite we still believe is
 * live — a `machine_sessions` row (which exists only while we believe that) or a
 * `machine_branches` row whose `spriteTornDownAt` is still NULL (that row
 * outlives its Sprite on purpose — it is re-creatable config) — AND which is
 * reclaimable at all: either a teardown was REQUESTED, or the page is past the
 * hard-purge cutoff. That last condition is the one that stops this cron from
 * irreversibly destroying the disk of every Machine a user merely dragged to the
 * trash. See `machine-orphan-reconcile.ts`'s module doc.
 *
 * Both release writes are COMPARE-AND-SWAPs against (page still trashed,
 * sandboxId unchanged). A restore or a concurrent re-provision that commits
 * between our kill and our write must NOT have its live Sprite recorded as dead
 * — that would hide it from this cron and from the hard-purge guard, orphaning
 * it permanently.
 */

import { and, asc, eq, exists, isNotNull, isNull, lt, or, sql } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import type {
  OrphanRow,
  ReconcileOrphanSpritesDeps,
} from '@pagespace/lib/services/machines/machine-orphan-reconcile';
import { trashPurgeCutoff } from '@pagespace/lib/repositories/page-repository';
import { getMachineHostForBranches } from './machine-branches-runtime';

/** The owning page is still trashed — the precondition every release write is conditional on. */
function owningPageStillTrashed(pageIdColumn: typeof machineSessions.pageId | typeof machineBranches.machineId) {
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
 */
export const MAX_CANDIDATES_PER_TABLE = 200;

export const defaultReconcileOrphanSpritesDeps: ReconcileOrphanSpritesDeps = {
  async listOrphanCandidates(): Promise<{ rows: OrphanRow[]; capped: boolean }> {
    // A kill is an irreversible DESTROY, so "the page is trashed" is never enough
    // on its own — trashing is reversible, and the generic page-trash paths tear
    // down nothing. A row is reclaimable only under one of the two tiers (see
    // `machine-orphan-reconcile.ts`): a teardown was REQUESTED, or the page is
    // past the point of restore and about to be erased anyway.
    const purgeCutoff = trashPurgeCutoff();
    const reclaimable = (
      teardownRequestedAt: typeof machineSessions.teardownRequestedAt | typeof machineBranches.teardownRequestedAt,
    ) =>
      or(isNotNull(teardownRequestedAt), lt(pages.trashedAt, purgeCutoff));

    const [sessionRows, branchRows] = await Promise.all([
      db
        .select({
          pageId: machineSessions.pageId,
          sessionKey: machineSessions.sessionKey,
          sandboxId: machineSessions.sandboxId,
        })
        .from(machineSessions)
        .innerJoin(pages, eq(machineSessions.pageId, pages.id))
        .where(and(eq(pages.isTrashed, true), reclaimable(machineSessions.teardownRequestedAt)))
        // Oldest-trashed first: the longest-billing orphans go first, and a
        // capped run can never starve a row indefinitely.
        .orderBy(asc(pages.trashedAt))
        .limit(MAX_CANDIDATES_PER_TABLE),
      db
        .select({
          pageId: machineBranches.machineId,
          id: machineBranches.id,
          sandboxId: machineBranches.sandboxId,
        })
        .from(machineBranches)
        .innerJoin(pages, eq(machineBranches.machineId, pages.id))
        // spriteTornDownAt IS NULL — an already-reclaimed branch row is pure
        // config now, not a live Sprite, so it is not a candidate.
        .where(
          and(
            eq(pages.isTrashed, true),
            isNull(machineBranches.spriteTornDownAt),
            reclaimable(machineBranches.teardownRequestedAt),
          ),
        )
        .orderBy(asc(pages.trashedAt))
        .limit(MAX_CANDIDATES_PER_TABLE),
    ]);

    return {
      rows: [
        ...sessionRows.map((row): OrphanRow => ({ kind: 'session', ...row })),
        ...branchRows.map((row): OrphanRow => ({ kind: 'branch', ...row })),
      ],
      // Either table hitting its cap means a backlog remains — report it rather
      // than letting a partial sweep look like a clean one.
      capped:
        sessionRows.length >= MAX_CANDIDATES_PER_TABLE || branchRows.length >= MAX_CANDIDATES_PER_TABLE,
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

  async killSprite(sandboxId) {
    try {
      const host = await getMachineHostForBranches();
      // Idempotent: an already-destroyed Sprite is a successful kill (see
      // `createSpriteMachineHost`'s `kill`), so a Sprite that vanished on its
      // own still releases its row instead of being retried forever.
      await host.kill({ machineId: sandboxId });
      return { ok: true };
    } catch (error) {
      // Reported, never thrown: the reconciler decides what to do with a failed
      // row (leave it exactly as-is for the next run) and must keep the batch going.
      return { ok: false, error };
    }
  },

  async releaseSessionRow({ sessionKey, sandboxId }) {
    const released = await db
      .delete(machineSessions)
      .where(
        and(
          eq(machineSessions.sessionKey, sessionKey),
          eq(machineSessions.sandboxId, sandboxId),
          owningPageStillTrashed(machineSessions.pageId),
        ),
      )
      .returning({ id: machineSessions.id });
    return released.length > 0;
  },

  async markBranchTornDown({ id, sandboxId }) {
    // Stamped, never deleted: the row is the user's branch-terminal config, and
    // its branch-scoped machine_agent_terminals FK-cascade off it.
    const marked = await db
      .update(machineBranches)
      .set({ spriteTornDownAt: new Date() })
      .where(
        and(
          eq(machineBranches.id, id),
          eq(machineBranches.sandboxId, sandboxId),
          owningPageStillTrashed(machineBranches.machineId),
        ),
      )
      .returning({ id: machineBranches.id });
    return marked.length > 0;
  },
};
