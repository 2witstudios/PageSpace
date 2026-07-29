/**
 * Orphan-teardown reconcile — the background reclaimer that kills Sprites
 * nothing points at any more.
 *
 * The successor to `services/machines/machine-orphan-reconcile.ts`, moved into
 * `sandbox/` because it is about SPRITES, not about machines: its subject is now
 * agent sessions, and the sandbox seam is where substrate-level concerns live.
 * The old module is deliberately left in place and unchanged — the machine world
 * keeps working, and its cron keeps calling it, until the teardown phase deletes
 * both it and the tables it enumerates. This module is what the crons switch to.
 *
 * TWO SOURCES OF WORK, because a Sprite can be orphaned in two different ways.
 *
 * (A) THE RECLAIM OUTBOX (`machine_sprite_reclaims`, kept under its physical
 *     name) — the pointer already lost its row. `agent_sessions` FK-cascades off
 *     `conversations`, `pages` and `users`, so every hard delete along any of
 *     those paths destroys the only record of a VM that may still be running:
 *     the 30-day purge, "delete permanently", a drive delete, the account-erasure
 *     worker, and whatever path someone writes next. Guarding each of those is
 *     unenforceable — there is always one more — and it cannot work for erasure
 *     at all, since GDPR Art. 17 must never be blocked by a Sprite we failed to
 *     kill. So we do not guard the deletes: an AFTER DELETE trigger copies the
 *     `sandboxId` into an outbox table with NO foreign keys, inside the deleting
 *     transaction (Postgres fires row triggers for CASCADE-deleted rows too). The
 *     pointer OUTLIVES the resource, and this cron kills whatever lands there.
 *     Rows leave the outbox only on a CONFIRMED kill, so a failure is retried
 *     forever rather than forgotten.
 *
 * (B) SESSION ROWS WHOSE TEARDOWN WAS REQUESTED BUT NEVER CONFIRMED — the row
 *     still exists, so nothing cascaded and the outbox never saw it.
 *     `endAgentSession` stamps `teardownRequestedAt` BEFORE it kills, so a failed
 *     kill (or a process that died mid-teardown) is reclaimable on the next tick.
 *
 * **`teardownRequestedAt` IS REQUIRED for (B), and that requirement is the whole
 * safety story.** A `host.kill` is an IRREVERSIBLE DESTROY — the VM's filesystem
 * goes with it, with no undo — whereas nothing else about a session is
 * irreversible. An idle session is NOT a candidate (idleness never destroys:
 * Sprites hibernate, and a row idle for years still resumes), a trashed agent
 * page is not a candidate (trash is reversible; if it is eventually purged the
 * cascade captures the Sprite into (A) and it dies then), and a merely-ended
 * session that already confirmed its kill has nothing left to do. Only an
 * explicit, recorded teardown intent licenses this cron to destroy anything.
 *
 * Against a race — a concurrent `ensure` that REVIVES a session after the
 * candidate list was read — there are two guards, mirroring the predecessor's
 * restore guards:
 *   1. `isTeardownStillRequested` is re-read immediately BEFORE the kill, so a
 *      session revived since listing is skipped entirely.
 *   2. `markSessionTornDown` is a COMPARE-AND-SWAP conditional on the row still
 *      pointing at the INSTANCE we killed. If a revive commits between the check
 *      and the write, the write no-ops rather than marking a LIVE Sprite dead —
 *      which would hide it from this reconciler AND from every other pointer,
 *      orphaning it forever. A lost race self-heals: the row keeps pointing at a
 *      dead sandboxId, and the next ensure re-provisions it under the same key.
 *
 * NO ADVISORY LOCK (unlike `machine-storage-reconcile.ts`, which needs one
 * because its charge is a non-idempotent money movement): every effect here is
 * naturally safe under concurrent runs. `killSprite` is idempotent (the host maps
 * a not-found error to success) and the CAS writes converge, so two overlapping
 * runs reach the same end state.
 *
 * Per-row failure isolation: one unreachable Sprite must never abort the batch,
 * and a row whose kill failed is deliberately LEFT UNTOUCHED so the next run
 * retries it — that row is the only pointer to the orphaned `sandboxId`, so
 * dropping it on failure would strand the Sprite forever.
 */

import { loggers } from '../../logging/logger-config';

/**
 * A Sprite we still believe is live and that is reclaimable under one of the two
 * sources above. Discriminated by where it came from: the two are released by
 * different keys and mean different things (see module doc).
 */
export type SpriteOrphanRow =
  /**
   * A pointer rescued from the reclaim outbox: its row was destroyed
   * (conversation deleted, page purged, drive deleted, account erased…), so
   * there is nothing to re-check and nothing to restore — the Sprite is
   * unreachable by definition and must die.
   */
  | { kind: 'reclaim'; sandboxId: string; spriteInstanceId: string | null }
  /**
   * An `agent_sessions` row whose teardown was REQUESTED but never confirmed.
   * The row OUTLIVES its Sprite on purpose — it is re-provisionable identity, and
   * deleting it would break the conversation's link to the sandbox it owned — so
   * the release is a STAMP, never a delete.
   */
  | { kind: 'agent-session'; sessionId: string; sandboxId: string; spriteInstanceId: string | null };

export interface ReconcileOrphanSpritesDeps {
  /**
   * Every Sprite believed live that satisfies one of the two sources — an outbox
   * pointer, or a session row with `teardownRequestedAt` set and
   * `spriteTornDownAt` still null.
   *
   * Reports `capped` itself: the runtime caps each query separately, so only it
   * can tell whether a backlog remains (one source can cap while the other comes
   * back empty).
   */
  /**
   * `incomplete` reports that a candidate SOURCE could not be read at all (as
   * opposed to `capped`, which means "read fine, more remain"). Without it a
   * source that fails every tick yields an empty list, and the run reports a
   * clean `{ capped: false, torndown: 0 }` — indistinguishable from "nothing
   * left to reclaim" while its Sprites bill indefinitely.
   */
  listOrphanCandidates: () => Promise<{ rows: SpriteOrphanRow[]; capped: boolean; incomplete?: boolean }>;
  /**
   * Fresh re-read of the session's teardown intent, immediately before the kill.
   * A session REVIVED since listing (a concurrent `ensure` clears the request as
   * part of recording the new identity) must not have its live Sprite destroyed.
   */
  isTeardownStillRequested: (sessionId: string) => Promise<boolean>;
  /**
   * Idempotent kill — an already-gone Sprite reports `ok`. Never throws; failures
   * come back as `{ ok: false }`.
   *
   * Takes the INSTANCE id as well as the name, and it is load-bearing: the kill
   * is name-keyed and a name is REUSED across re-creates, so "destroy whatever
   * holds this name" would destroy a replacement VM that legitimately took the
   * name after our target was already gone.
   */
  killSprite: (input: {
    sandboxId: string;
    spriteInstanceId: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: unknown }>;
  /** CAS-stamp `spriteTornDownAt` on the session row (never delete it — it is re-provisionable identity): only if the row still points at the INSTANCE we killed. Reports whether it actually wrote. */
  markSessionTornDown: (input: {
    sessionId: string;
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
   * True when a candidate remained BEYOND the runtime's per-run cap — a backlog
   * this run did not attempt. Surfaced (not swallowed) because a silent
   * truncation reads exactly like "nothing left to reclaim" while the
   * un-attempted Sprites keep billing. The backlog drains over subsequent ticks,
   * oldest first.
   */
  capped: boolean;
  /**
   * True when at least one candidate SOURCE could not be listed this run. A
   * clean-looking result with this set is NOT a clean run: the reclaimable
   * Sprites behind that source were never even considered.
   */
  incomplete: boolean;
  /** Rows whose Sprite is now confirmed gone AND whose pointer was released/stamped. */
  torndown: number;
  /** Rows left alone because their session was revived mid-run, or because the CAS lost to a concurrent re-provision. Benign — see module doc. */
  skipped: number;
  /** Rows whose kill failed — left exactly as they were, retried next run. A persistently non-zero count means a Sprite is stuck billing. */
  failed: number;
}

export async function reconcileOrphanSprites(
  deps: ReconcileOrphanSpritesDeps,
): Promise<ReconcileOrphanSpritesResult> {
  const { rows, capped, incomplete = false } = await deps.listOrphanCandidates();

  let torndown = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      // Guard 1 (session rows only): a revive that landed since the candidate
      // list was read. Killing a revived session's Sprite would destroy a live
      // VM's filesystem — the one genuinely irreversible mistake this cron could
      // make. An outbox row has no session left to revive, so it skips this.
      if (row.kind === 'agent-session' && !(await deps.isTeardownStillRequested(row.sessionId))) {
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
          // Record the failure ON the outbox row, so a Sprite that cannot be
          // killed surfaces as a growing attempt count instead of being retried
          // silently forever. Isolated: if this bookkeeping write ITSELF fails,
          // the row has already been counted as failed, and letting it throw to
          // the outer catch would count it twice AND lose the kill error we came
          // here to report.
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
      // idempotent). Only NOW release the pointer, and for a session row only via
      // a CAS (guard 2), so a re-provision that raced us cannot have a LIVE Sprite
      // marked dead.
      if (row.kind === 'reclaim') {
        // No row, no CAS to lose: the Sprite is confirmed gone, so the pointer has
        // done its job.
        await deps.releaseReclaim(row.sandboxId);
        torndown += 1;
        continue;
      }

      const released = await deps.markSessionTornDown({
        sessionId: row.sessionId,
        sandboxId: row.sandboxId,
        spriteInstanceId: row.spriteInstanceId,
      });
      if (!released) {
        skipped += 1;
        continue;
      }
      torndown += 1;
    } catch (error) {
      // Isolated per-row: one bad row must never drop the rest of the batch. A
      // release failure AFTER a successful kill is harmless — the next run's kill
      // is idempotent, so it simply releases the pointer then.
      failed += 1;
      loggers.ai.error(
        'Orphan sprite reconcile failed for row',
        error instanceof Error ? error : new Error(String(error)),
        { sandboxId: row.sandboxId, kind: row.kind },
      );
    }
  }

  return { processed: rows.length, capped, incomplete, torndown, skipped, failed };
}
