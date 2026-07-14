/**
 * Default (real) IO composition for the orphan-teardown reconcile cron (Sprites
 * Idle-Cost Remediation) — binds `reconcileOrphanSprites`'s deps seam to the
 * real `machine_sessions` / `machine_branches` tables and the Sprite
 * `MachineHost`. Mirrors `machine-storage-billing.ts`'s default-deps pattern.
 *
 * The candidate query is the whole design: join each tracking table to `pages`
 * and keep the rows whose owning page `isTrashed`. Both tables now delete their
 * row only after a CONFIRMED kill (see `machine-settings-runtime.ts`'s teardown
 * and `killBranch`), so a surviving row under a trashed page is by construction
 * a Sprite whose teardown never completed — no `teardownPendingAt` column, no
 * migration. See `machine-orphan-reconcile.ts`'s module doc.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { createDbMachineSessionStore } from '@pagespace/lib/services/sandbox/machine-session-manager';
import type {
  OrphanRow,
  ReconcileOrphanSpritesDeps,
} from '@pagespace/lib/services/machines/machine-orphan-reconcile';
import { getMachineHostForBranches } from './machine-branches-runtime';

export const defaultReconcileOrphanSpritesDeps: ReconcileOrphanSpritesDeps = {
  async listOrphanCandidates(): Promise<OrphanRow[]> {
    const [sessionRows, branchRows] = await Promise.all([
      db
        .select({ sessionKey: machineSessions.sessionKey, sandboxId: machineSessions.sandboxId })
        .from(machineSessions)
        .innerJoin(pages, eq(machineSessions.pageId, pages.id))
        .where(eq(pages.isTrashed, true)),
      db
        .select({ id: machineBranches.id, sandboxId: machineBranches.sandboxId })
        .from(machineBranches)
        .innerJoin(pages, eq(machineBranches.machineId, pages.id))
        .where(eq(pages.isTrashed, true)),
    ]);

    return [
      ...sessionRows.map((row): OrphanRow => ({ kind: 'session', ...row })),
      ...branchRows.map((row): OrphanRow => ({ kind: 'branch', ...row })),
    ];
  },

  async killSprite(sandboxId) {
    try {
      const host = await getMachineHostForBranches();
      // Idempotent: an already-destroyed Sprite is a successful kill (see
      // `createSpriteMachineHost`'s `kill`), so a Sprite that vanished on its
      // own still clears its tracking row instead of failing forever.
      await host.kill({ machineId: sandboxId });
      return { ok: true };
    } catch (error) {
      // Reported, never thrown: the reconciler decides what to do with a failed
      // row (leave it in place for the next run), and it must keep the batch going.
      return { ok: false, error };
    }
  },

  async removeSessionRow(sessionKey) {
    const sessionStore = await createDbMachineSessionStore();
    await sessionStore.remove(sessionKey);
  },

  async removeBranchRow(id) {
    await db.delete(machineBranches).where(eq(machineBranches.id, id));
  },
};
