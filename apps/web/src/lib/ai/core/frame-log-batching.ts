/**
 * Pure decision logic for when the durable frame log flushes a batch.
 *
 * No DB, no timers, no I/O — `frame-log-writer.ts` supplies the clock and the pending
 * counters on every appended frame and on every tick of its own interval. Kept separate for
 * the same reason `checkpoint-scheduler.ts` is: the cadence is the part with the interesting
 * edges, and it can be exhaustively tested with an injected clock instead of fake timers.
 *
 * HOW THIS DIFFERS FROM `decideCheckpoint`, which it otherwise resembles. The checkpoint
 * REWRITES one jsonb column, so skipping a flush loses nothing — the next one carries the
 * same content plus more, and `persistInFlight` can therefore veto. The frame log APPENDS,
 * so every frame must land exactly once: there is no `writeInFlight` veto here, and a caller
 * that finds a write already in flight must QUEUE the batch rather than drop the decision.
 * Getting that backwards would silently punch holes in the durable record — the one failure
 * this table exists to prevent.
 */

/**
 * Batch size cap. Small enough that a rejoining client is never far behind a fast token
 * stream, large enough that a 2000-frame reply is ~30 rows rather than 2000.
 */
export const FRAME_FLUSH_MAX_FRAMES = 64;

/**
 * Age cap on the OLDEST pending frame — not on the last write.
 *
 * Anchoring on the oldest frame is what makes this a staleness bound: it says "no frame
 * waits longer than this to become durable", which is the property a crash recovery needs.
 * Anchoring on the last write instead would let a slow trickle of frames sit unflushed
 * indefinitely as long as writes kept happening for other reasons.
 */
export const FRAME_FLUSH_INTERVAL_MS = 200;

/**
 * Byte cap on a single batch, measured with the channel's own frame estimator.
 *
 * Bounds the size of one INSERT's jsonb payload. A single tool output can carry megabytes,
 * so without this a batch of 64 frames is not a bounded write at all — the same hole the
 * channel's byte budget closed for the memory ring.
 */
export const FRAME_FLUSH_MAX_BYTES = 256 * 1024;

export interface FrameFlushDecisionInput {
  /** Frames buffered and not yet written. */
  readonly pendingFrames: number;
  /** Estimated serialized size of those frames. */
  readonly pendingBytes: number;
  /**
   * True when the frame that triggered this decision is a durability boundary — a tool or
   * step boundary, a route-written data part, an error. See `isDurabilityBoundary`.
   */
  readonly isBoundary: boolean;
  /** Epoch ms at which the oldest pending frame was buffered. */
  readonly oldestPendingAt: number;
  /** Injected clock, epoch ms. */
  readonly now: number;
}

export const shouldFlushFrames = (input: FrameFlushDecisionInput): boolean => {
  const { pendingFrames, pendingBytes, isBoundary, oldestPendingAt, now } = input;

  // Nothing to write. Checked first so an empty interval tick — and a boundary frame that
  // some future caller reports without having buffered it — can never emit an empty row.
  if (pendingFrames === 0) return false;

  // A tool or step boundary goes out now, so a rejoining client sees it without waiting on
  // the throttle. This is the whole reason the writer takes the frame's type at all.
  if (isBoundary) return true;

  if (pendingFrames >= FRAME_FLUSH_MAX_FRAMES) return true;
  if (pendingBytes >= FRAME_FLUSH_MAX_BYTES) return true;

  return now - oldestPendingAt >= FRAME_FLUSH_INTERVAL_MS;
};
