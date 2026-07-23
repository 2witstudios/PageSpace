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
 * TWO SOURCES OF WORK, because a Sprite can be orphaned in two different ways.
 *
 * (A) THE RECLAIM OUTBOX (`machine_sprite_reclaims`) — the pointer already lost
 *     its page. `machine_sessions`/`machine_branches` FK-cascade off `pages.id`
 *     (and off `users.id`), so EVERY hard delete of a page destroys the only
 *     record of a VM that may still be running: the 30-day purge, "delete
 *     permanently" from the trash, a permanent drive delete, the account-erasure
 *     worker, and whatever path someone writes next. Guarding each of those is
 *     unenforceable — there is always one more — and it cannot work for erasure
 *     at all, since GDPR Art. 17 must never be blocked by a Sprite we failed to
 *     kill. So we do not guard the deletes: an AFTER DELETE trigger on each
 *     tracking table copies the `sandboxId` into an outbox table that has NO
 *     foreign keys, inside the deleting transaction (Postgres fires row triggers
 *     for CASCADE-deleted rows too). The pointer OUTLIVES the resource, and this
 *     cron kills whatever lands there. Rows leave the outbox only on a CONFIRMED
 *     kill, so a failure is retried forever rather than forgotten.
 *
 * (B) TRACKING ROWS WHOSE TEARDOWN WAS REQUESTED BUT NEVER CONFIRMED — the page
 *     still exists (trashed), so nothing was cascaded and the outbox never saw
 *     it. `deleteMachine` stamps `teardownRequestedAt` BEFORE it kills, so a
 *     failed kill (or a process that died mid-teardown) is reclaimable here on
 *     the next tick, instead of waiting ~30 days for the page to be purged.
 *
 * WHAT IS *NOT* RECLAIMABLE, and why (B) needs the intent stamp at all: a
 * `host.kill` is an IRREVERSIBLE DESTROY — the VM's whole filesystem (repos,
 * uncommitted work, credentials) is gone with no undo. But a TRASH is reversible,
 * and `pageService.trashPage` (the generic page DELETE, bulk delete, and folder
 * cascade-trash) trashes a MACHINE page with NO teardown: its Sprite simply
 * hibernates, and a restore is expected to hand the disk back intact. Keying on
 * `pages.isTrashed` alone would therefore wipe the disk of every Machine anyone
 * ever dragged to the trash. Those Sprites are left alone; if the page is
 * eventually purged, the trigger captures them into (A) and they die then.
 *
 * THE LIVE-SPRITE SIGNAL for (B) is expressed differently per table, because the
 * two rows mean different things:
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
 * Restores are safe. A restore flips `pages.isTrashed` back to false, so a
 * restored Machine stops being a candidate on the next run — and under tier 1 the
 * Sprite is already dead anyway (that is what `deleteMachine` asked for). Against
 * a restore that commits MID-RUN, after the candidate list was read, two guards:
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
 * LEFT UNTOUCHED so the next run retries it — that row is the only pointer to the
 * orphaned `sandboxId`, so dropping it on failure would strand the Sprite forever.
 *
 * Note what the outbox makes UNNECESSARY: the hard purge needs no guard against
 * deleting a page whose Sprite is still live, because the cascade can no longer
 * lose the pointer. Erasure always proceeds, no page is ever unpurgeable (which a
 * guard would have risked — an Art. 17 retention bug), and the Sprite it orphans
 * is reclaimed on the next tick.
 */

import { loggers } from '../../logging/logger-config';

/**
 * A Sprite we still believe is live, whose owning Machine page is trashed AND
 * which is reclaimable under one of the two tiers above — i.e. a teardown that
 * never confirmed, or a page that is past the point of restore. Discriminated by
 * the table it came from: the two are released by different keys, and mean
 * different things (see module doc).
 */
export type OrphanRow =
  /**
   * A pointer rescued from the reclaim outbox: its tracking row was destroyed
   * (page purged, drive deleted, account erased…), so there is no page to check
   * and nothing to restore — the Sprite is unreachable by definition and must
   * die. See source (A) in the module doc.
   */
  | { kind: 'reclaim'; sandboxId: string; spriteInstanceId: string | null }
  | { kind: 'session'; pageId: string; sessionKey: string; sandboxId: string; spriteInstanceId: string | null }
  | { kind: 'branch'; pageId: string; id: string; sandboxId: string; spriteInstanceId: string | null }
  /** A PROMOTED project's Sprite — same row-outlives-Sprite contract as a branch, released by the same CAS-stamp. */
  | { kind: 'project'; pageId: string; id: string; sandboxId: string; spriteInstanceId: string | null };

export interface ReconcileOrphanSpritesDeps {
  /**
   * Every Sprite believed live under a trashed page that ALSO satisfies one of
   * the two reclaim tiers — teardown requested, or page past the hard-purge
   * cutoff (see module doc; keying on `isTrashed` alone would destroy the disk of
   * every merely-trashed Machine).
   *
   * Reports `capped` itself: the runtime caps each table's query separately, so
   * only it can tell whether a backlog remains (one table can cap while the other
   * comes back empty).
   */
  listOrphanCandidates: () => Promise<{ rows: OrphanRow[]; capped: boolean }>;
  /** Fresh re-read of the owning page's trash state, immediately before the kill — a restore that landed since listing must not have its live Sprite destroyed. */
  isStillTrashed: (pageId: string) => Promise<boolean>;
  /**
   * Idempotent kill — an already-gone Sprite reports `ok` (see `MachineHost.kill`).
   * Never throws; failures come back as `{ ok: false }`.
   *
   * Takes the INSTANCE id as well as the name, and it is load-bearing: the kill is
   * name-keyed, and a name is REUSED across re-creates, so "destroy whatever holds
   * this name" would destroy a replacement VM that legitimately took the name after
   * our target was already gone. With the instance id, a mismatch means our target
   * is dead and the newcomer is left alone.
   */
  killSprite: (input: {
    sandboxId: string;
    spriteInstanceId: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: unknown }>;
  /** CAS-delete the session row: only if the page is STILL trashed and the row still points at the INSTANCE we killed. Reports whether it actually wrote. */
  releaseSessionRow: (input: {
    sessionKey: string;
    sandboxId: string;
    spriteInstanceId: string | null;
  }) => Promise<boolean>;
  /** CAS-stamp `spriteTornDownAt` on the branch row (never delete it — it is re-creatable config): only if the page is STILL trashed and the row still points at the INSTANCE we killed. Reports whether it actually wrote. */
  markBranchTornDown: (input: {
    id: string;
    sandboxId: string;
    spriteInstanceId: string | null;
  }) => Promise<boolean>;
  /** CAS-stamp `spriteTornDownAt` on the promoted-project row — identical contract to `markBranchTornDown` (a re-promotion that raced us must not have its live Sprite marked dead). */
  markProjectTornDown: (input: {
    id: string;
    sandboxId: string;
    spriteInstanceId: string | null;
  }) => Promise<boolean>;
  /** Drop an outbox row — ONLY after its Sprite is confirmed gone. */
  releaseReclaim: (sandboxId: string) => Promise<void>;
  /** Record a failed kill against its outbox row (attempts/lastError) so a Sprite that cannot be killed becomes visible rather than silently retried forever. */
  noteReclaimFailure: (input: { sandboxId: string; error: unknown }) => Promise<void>;
}

export interface ReconcileOrphanSpritesResult {
  processed: number;
  /**
   * True when a candidate remained BEYOND the runtime's per-run cap — i.e. a
   * backlog this run did not attempt. Surfaced (not swallowed) because a silent
   * truncation reads exactly like "nothing left to reclaim" while the
   * un-attempted Sprites keep billing. The backlog drains over subsequent ticks,
   * oldest first. (The runtime proves the backlog with a one-row lookahead rather
   * than inferring it from an exactly-full result, which would cry wolf.)
   */
  capped: boolean;
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
  const { rows, capped } = await deps.listOrphanCandidates();

  let torndown = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      // Guard 1 (tracking rows only): a restore that landed since the candidate
      // list was read. Killing a restored Machine's Sprite would destroy a live
      // VM's filesystem — the one genuinely irreversible mistake this cron could
      // make. An outbox row has no page left to restore, so it skips this.
      if (row.kind !== 'reclaim' && !(await deps.isStillTrashed(row.pageId))) {
        skipped += 1;
        continue;
      }

      const killed = await deps.killSprite({
        sandboxId: row.sandboxId,
        spriteInstanceId: row.spriteInstanceId,
      });
      if (!killed.ok) {
        // Leave the row EXACTLY as it is: it is the only pointer to this
        // sandboxId. The next run retries it.
        failed += 1;
        if (row.kind === 'reclaim') {
          // Record the failure ON the outbox row, so a Sprite that cannot be killed
          // surfaces as a growing attempt count instead of being retried silently
          // forever. Isolated: if this bookkeeping write ITSELF fails, the row has
          // already been counted as failed, and letting it throw to the outer catch
          // would count it twice AND lose the kill error we actually came here to
          // report. The Sprite is retried next run either way.
          try {
            await deps.noteReclaimFailure({ sandboxId: row.sandboxId, error: killed.error });
          } catch (noteError) {
            loggers.ai.error(
              'Failed to record an orphan sprite kill failure against its outbox row',
              noteError instanceof Error ? noteError : new Error(String(noteError)),
              { sandboxId: row.sandboxId },
            );
          }
        }
        loggers.ai.error(
          'Orphan sprite teardown failed; leaving pointer for retry',
          killed.error instanceof Error ? killed.error : new Error(String(killed.error)),
          { sandboxId: row.sandboxId, kind: row.kind },
        );
        continue;
      }

      // The Sprite is confirmed gone (killed, or already absent — the kill is
      // idempotent). Only NOW release the row — and only via a CAS (guard 2), so
      // a restore or re-provision that raced us cannot have a LIVE Sprite marked
      // dead.
      if (row.kind === 'reclaim') {
        // No page, no CAS to lose: the Sprite is confirmed gone, so the pointer
        // has done its job.
        await deps.releaseReclaim(row.sandboxId);
        torndown += 1;
        continue;
      }

      const released =
        row.kind === 'session'
          ? await deps.releaseSessionRow({
              sessionKey: row.sessionKey,
              sandboxId: row.sandboxId,
              spriteInstanceId: row.spriteInstanceId,
            })
          : row.kind === 'branch'
            ? await deps.markBranchTornDown({
                id: row.id,
                sandboxId: row.sandboxId,
                spriteInstanceId: row.spriteInstanceId,
              })
            : await deps.markProjectTornDown({
                id: row.id,
                sandboxId: row.sandboxId,
                spriteInstanceId: row.spriteInstanceId,
              });

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

  return { processed: rows.length, capped, torndown, skipped, failed };
}
