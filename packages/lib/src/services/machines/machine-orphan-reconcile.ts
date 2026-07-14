/**
 * Orphan-teardown reconcile (Sprites Idle-Cost Remediation) — the background
 * reclaimer that `deleteMachine`'s doc comment has always promised but that
 * never existed.
 *
 * `deleteMachine` (services/machines/machine-settings.ts) trashes the Machine
 * page FIRST, then tears the Sprites down BEST-EFFORT: a `host.kill()` failure
 * returns `spriteTornDown: false` and is documented as "an acceptable,
 * recoverable state a background reconciler can reclaim". Until this module
 * there was no such reconciler, so a failed kill left a live, billable microVM
 * with NO reachable owner: the page is trashed (invisible in the app), and
 * nothing else in the product ever looks at `machine_sessions`/`machine_branches`
 * for a trashed page. We found exactly one of these in production — a `pgs-sbx-…`
 * Sprite stuck `running`, unreferenced by any live page, quietly billing RAM.
 *
 * THE PENDING-TEARDOWN SIGNAL (why no new column / migration):
 * both tracking tables now delete their row ONLY after a CONFIRMED kill —
 * `machine_sessions` already did (`teardownOneMachine`), and `machine_branches`
 * now does too. So a row that still exists while its owning page is trashed is,
 * by construction, a Sprite whose teardown never completed. "Row exists + page
 * trashed" IS the signal; no `teardownPendingAt` column is needed.
 *
 * Restores are safe: a restore flips `pages.isTrashed` back to false, so a
 * restored Machine simply stops being a candidate on the next run. The only way
 * a live Machine's Sprite gets killed here is if its page is genuinely trashed —
 * which is exactly when the compute should already be gone.
 *
 * NO ADVISORY LOCK (unlike `machine-storage-reconcile.ts`, which needs one
 * because its charge is a non-idempotent money movement): every effect here is
 * naturally safe under concurrent runs. `killSprite` is idempotent (the Sprite
 * host maps a not-found error to success), and deleting an already-deleted row
 * is a no-op. Two overlapping runs converge on the same end state; the crontab's
 * `flock` is enough to keep this container's own ticks from doing redundant work.
 *
 * Per-row failure isolation mirrors the storage reconcile: one unreachable
 * Sprite must never abort the batch, and a row whose kill failed is deliberately
 * LEFT IN PLACE so the next run retries it — the row is the only pointer to the
 * orphaned `sandboxId`, so dropping it on failure would strand the Sprite
 * forever. That is also why the 30-day hard purge now refuses to delete a page
 * that still has a tracking row (see `purgeExpiredTrashedPages`): the FK cascade
 * would otherwise destroy the pointer.
 */

import { loggers } from '../../logging/logger-config';

/**
 * A tracking row whose owning Machine page is trashed — i.e. a Sprite whose
 * teardown never confirmed. Discriminated by the table it came from, since the
 * two are removed by different keys (`machine_sessions` by its opaque session
 * key, `machine_branches` by row id).
 */
export type OrphanRow =
  | { kind: 'session'; sessionKey: string; sandboxId: string }
  | { kind: 'branch'; id: string; sandboxId: string };

export interface ReconcileOrphanSpritesDeps {
  /** Every machine_sessions/machine_branches row whose owning page is trashed — the row's mere continued existence past trash-time IS the pending-teardown signal (see module doc). */
  listOrphanCandidates: () => Promise<OrphanRow[]>;
  /** Idempotent kill by sandboxId — an already-gone Sprite reports `ok` (see `MachineHost.kill`'s not-found handling). Never throws; failures come back as `{ ok: false }`. */
  killSprite: (sandboxId: string) => Promise<{ ok: true } | { ok: false; error: unknown }>;
  removeSessionRow: (sessionKey: string) => Promise<void>;
  removeBranchRow: (id: string) => Promise<void>;
}

export interface ReconcileOrphanSpritesResult {
  processed: number;
  /** Rows whose Sprite is now confirmed gone and whose tracking row was removed. */
  torndown: number;
  /** Rows whose kill (or row removal) failed — left in place, retried next run. A persistently non-zero count means a Sprite is stuck billing. */
  failed: number;
}

export async function reconcileOrphanSprites(
  deps: ReconcileOrphanSpritesDeps,
): Promise<ReconcileOrphanSpritesResult> {
  const rows = await deps.listOrphanCandidates();

  let torndown = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const killed = await deps.killSprite(row.sandboxId);
      if (!killed.ok) {
        // Leave the row: it is the ONLY pointer to this sandboxId. Next run retries.
        failed += 1;
        loggers.ai.error(
          'Orphan sprite teardown failed; leaving tracking row for retry',
          killed.error instanceof Error ? killed.error : new Error(String(killed.error)),
          { sandboxId: row.sandboxId, kind: row.kind },
        );
        continue;
      }

      // Sprite is confirmed gone (killed, or already absent — the kill is
      // idempotent). Only NOW is it safe to drop the pointer.
      if (row.kind === 'session') {
        await deps.removeSessionRow(row.sessionKey);
      } else {
        await deps.removeBranchRow(row.id);
      }
      torndown += 1;
    } catch (error) {
      // Isolated per-row (same rule as machine-storage-reconcile): one bad row
      // must never drop the rest of the batch. A row-removal failure AFTER a
      // successful kill is harmless — the next run's kill is idempotent, so it
      // simply removes the row then.
      failed += 1;
      loggers.ai.error(
        'Orphan sprite reconcile failed for row',
        error instanceof Error ? error : new Error(String(error)),
        { sandboxId: row.sandboxId, kind: row.kind },
      );
    }
  }

  return { processed: rows.length, torndown, failed };
}
