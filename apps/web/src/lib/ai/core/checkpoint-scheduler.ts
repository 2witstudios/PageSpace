/**
 * Pure decision logic for when a parts checkpoint may write to `aiStreamSessions`.
 *
 * No DB, no timers, no I/O — `stream-lifecycle.ts` supplies the clock (`now`) and the rest of
 * the state on every pushed part and on every tick of its 1s checkpoint interval. Kept separate
 * from that file (and from `checkpoint-serialize.ts`, which shapes what gets written) so the
 * scheduling decision can be 100%-branch tested with an injected clock instead of fake timers.
 *
 * Replaces the old PERSIST_EVERY_N_PARTS=20 counter, which could leave a snapshot minutes stale
 * inside a long tool call (no parts pushed) or lag behind a token-fast reply by up to 19 tokens'
 * worth of content. Time-based cadence bounds staleness by wall clock instead of chunk count.
 */

export const CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS = 1000;

export interface CheckpointDecisionInput {
  /** True when the in-memory buffer holds content not yet reflected in the last checkpoint write. */
  readonly dirty: boolean;
  /**
   * True when the part that triggered this decision is a tool part (input-available,
   * output-available, output-error) rather than a text delta — a rejoining client should see a
   * tool call start or finish immediately, not wait out the dirty-flush throttle.
   */
  readonly isToolBoundary: boolean;
  /** True while a previous checkpoint write is still in flight. Never start a second one. */
  readonly persistInFlight: boolean;
  /** Epoch ms of the last checkpoint write (or stream start, if none yet). */
  readonly lastPersistAt: number;
  /**
   * Epoch ms past which the lifecycle's heartbeat interval stops beating (MAX_HEARTBEAT_MS from
   * `stream-lifecycle.ts`). The checkpoint MUST obey the same horizon — it also refreshes
   * `lastHeartbeatAt`, so a checkpoint that ignored this deadline would keep an abandoned-cap
   * generation looking alive forever. See stream-lifecycle.ts's MAX_HEARTBEAT_MS docblock.
   */
  readonly heartbeatDeadline: number;
  /** Injected clock, epoch ms. */
  readonly now: number;
}

export const decideCheckpoint = (input: CheckpointDecisionInput): boolean => {
  const { dirty, isToolBoundary, persistInFlight, lastPersistAt, heartbeatDeadline, now } = input;

  if (persistInFlight) return false;
  if (now > heartbeatDeadline) return false;
  if (!dirty) return false;
  if (isToolBoundary) return true;

  return now - lastPersistAt >= CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS;
};
