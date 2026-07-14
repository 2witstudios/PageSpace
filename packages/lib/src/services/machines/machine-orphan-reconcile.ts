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
 * THE PENDING-TEARDOWN SIGNAL — "a Sprite we still believe is LIVE, under a
 * page that is trashed" — is expressed differently per table, because the two
 * rows mean different things:
 *
 *   • `machine_sessions`: the row IS the live-Sprite pointer and nothing else.
 *     It is deleted on a confirmed kill (`teardownOneMachine`), and the storage
 *     reconcile bills every row it finds — so a row that outlived its Sprite
 *     would keep billing storage for a destroyed VM. Signal = the row EXISTS.
 *
 *   • `machine_branches`: the row OUTLIVES its Sprite on purpose. It is
 *     re-creatable CONFIGURATION — `spawnBranch` re-provisions a vanished branch
 *     under the same `sessionKey` and re-clones from the project's `repoUrl` —
 *     and its branch-scoped `machine_agent_terminals` rows FK-cascade off it.
 *     Deleting it on teardown would destroy the user's branch config, and their
 *     agent terminals with it, on a REVERSIBLE soft-delete. So teardown STAMPS
 *     `spriteTornDownAt` and keeps the row. Signal = `spriteTornDownAt IS NULL`.
 *
 * Restores are safe, and safe against a RACE with this cron. A restore flips
 * `pages.isTrashed` back to false, so a restored Machine stops being a candidate
 * on the next run — but a restore that commits mid-run, after the candidate list
 * was read, would otherwise still get its live Sprite killed (destroying the VM's
 * filesystem). Two guards, both required:
 *   1. `isStillTrashed` is re-read immediately BEFORE the kill, so a restore that
 *      landed since listing skips the row entirely (counted as `skipped`).
 *   2. `releaseSessionRow`/`markBranchTornDown` are COMPARE-AND-SWAP writes,
 *      conditional on the page still being trashed AND `sandboxId` still being
 *      the one we just killed. If a restore (or a concurrent re-provision under
 *      the same branch row) commits between the check and the write, the write
 *      no-ops rather than marking a live Sprite as dead — which would hide it
 *      from this reconciler AND from the hard-purge guard, orphaning it forever.
 *      A lost race self-heals: the row keeps pointing at a dead `sandboxId`, and
 *      the next attach re-provisions it (`spawnBranch`'s "vanished" path).
 *
 * NO ADVISORY LOCK (unlike `machine-storage-reconcile.ts`, which needs one
 * because its charge is a non-idempotent money movement): every effect here is
 * naturally safe under concurrent runs. `killSprite` is idempotent (the Sprite
 * host maps a not-found error to success), and the CAS writes above converge.
 * Two overlapping runs reach the same end state; the crontab's `flock` is enough
 * to stop this container's own ticks from doing redundant work.
 *
 * Per-row failure isolation mirrors the storage reconcile: one unreachable
 * Sprite must never abort the batch, and a row whose kill failed is deliberately
 * LEFT UNTOUCHED so the next run retries it — the row is the only pointer to the
 * orphaned `sandboxId`, so dropping it on failure would strand the Sprite
 * forever. That is also why the 30-day hard purge refuses to delete a page that
 * still has a live-Sprite row (see `purgeExpiredTrashedPages`): the FK cascade
 * would otherwise destroy the pointer.
 */

import { loggers } from '../../logging/logger-config';

/**
 * A Sprite we still believe is live, whose owning Machine page is trashed — i.e.
 * a teardown that never confirmed. Discriminated by the table it came from: the
 * two are released by different keys, and mean different things (see module doc).
 */
export type OrphanRow =
  | { kind: 'session'; pageId: string; sessionKey: string; sandboxId: string }
  | { kind: 'branch'; pageId: string; id: string; sandboxId: string };

export interface ReconcileOrphanSpritesDeps {
  /** Every `machine_sessions` row, and every NOT-yet-torn-down `machine_branches` row, whose owning page is trashed (see module doc on the two signals). */
  listOrphanCandidates: () => Promise<OrphanRow[]>;
  /** Fresh re-read of the owning page's trash state, immediately before the kill — a restore that landed since listing must not have its live Sprite destroyed. */
  isStillTrashed: (pageId: string) => Promise<boolean>;
  /** Idempotent kill by sandboxId — an already-gone Sprite reports `ok` (see `MachineHost.kill`'s not-found handling). Never throws; failures come back as `{ ok: false }`. */
  killSprite: (sandboxId: string) => Promise<{ ok: true } | { ok: false; error: unknown }>;
  /** CAS-delete the session row: only if the page is STILL trashed and `sandboxId` is still the one we killed. Reports whether it actually wrote. */
  releaseSessionRow: (input: { sessionKey: string; sandboxId: string }) => Promise<boolean>;
  /** CAS-stamp `spriteTornDownAt` on the branch row (never delete it — it is re-creatable config): only if the page is STILL trashed and `sandboxId` is still the one we killed. Reports whether it actually wrote. */
  markBranchTornDown: (input: { id: string; sandboxId: string }) => Promise<boolean>;
}

export interface ReconcileOrphanSpritesResult {
  processed: number;
  /** Rows whose Sprite is now confirmed gone AND whose row was released/stamped. */
  torndown: number;
  /** Rows left alone because their page was restored mid-run, or because the CAS lost to a concurrent restore/re-provision. Benign — see module doc. */
  skipped: number;
  /** Rows whose kill failed — left exactly as they were, retried next run. A persistently non-zero count means a Sprite is stuck billing. */
  failed: number;
}

export async function reconcileOrphanSprites(
  deps: ReconcileOrphanSpritesDeps,
): Promise<ReconcileOrphanSpritesResult> {
  const rows = await deps.listOrphanCandidates();

  let torndown = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      // Guard 1: a restore that landed since the candidate list was read. Killing
      // a restored Machine's Sprite would destroy a live VM's filesystem — the
      // one genuinely irreversible mistake this cron could make.
      if (!(await deps.isStillTrashed(row.pageId))) {
        skipped += 1;
        continue;
      }

      const killed = await deps.killSprite(row.sandboxId);
      if (!killed.ok) {
        // Leave the row EXACTLY as it is: it is the only pointer to this
        // sandboxId. The next run retries it.
        failed += 1;
        loggers.ai.error(
          'Orphan sprite teardown failed; leaving tracking row for retry',
          killed.error instanceof Error ? killed.error : new Error(String(killed.error)),
          { sandboxId: row.sandboxId, kind: row.kind },
        );
        continue;
      }

      // The Sprite is confirmed gone (killed, or already absent — the kill is
      // idempotent). Only NOW release the row — and only via a CAS (guard 2), so
      // a restore or re-provision that raced us cannot have a LIVE Sprite marked
      // dead.
      const released =
        row.kind === 'session'
          ? await deps.releaseSessionRow({ sessionKey: row.sessionKey, sandboxId: row.sandboxId })
          : await deps.markBranchTornDown({ id: row.id, sandboxId: row.sandboxId });

      if (!released) {
        skipped += 1;
        continue;
      }
      torndown += 1;
    } catch (error) {
      // Isolated per-row (same rule as machine-storage-reconcile): one bad row
      // must never drop the rest of the batch. A release failure AFTER a
      // successful kill is harmless — the next run's kill is idempotent, so it
      // simply releases the row then.
      failed += 1;
      loggers.ai.error(
        'Orphan sprite reconcile failed for row',
        error instanceof Error ? error : new Error(String(error)),
        { sandboxId: row.sandboxId, kind: row.kind },
      );
    }
  }

  return { processed: rows.length, torndown, skipped, failed };
}
