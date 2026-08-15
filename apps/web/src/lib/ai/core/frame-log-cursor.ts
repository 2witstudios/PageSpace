import type { UIMessageChunk } from 'ai';
import { db } from '@pagespace/db/db';
import { and, asc, eq, gte, lte, max } from '@pagespace/db/operators';
import { aiStreamFrames } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * INCREMENTAL reads of the durable frame log, from a cursor.
 *
 * `readFrames` (frame-log.ts) answers "the whole message, once, for a recovery". This answers
 * "what is new since seq N", called every few hundred milliseconds while a stream on ANOTHER
 * web instance is still generating. Same table, same contiguity rule, different shape of
 * question — and keeping them separate is deliberate: the recovery read is allowed to be
 * expensive and exhaustive, this one has to be cheap enough to run on a timer.
 *
 * ── WHY TWO CURSORS AND NOT THE SCHEMA DOCBLOCK'S PREDICATE ─────────────────────────────────
 *
 * `ai_stream_frames`'s own docblock suggests
 *
 *     WHERE message_id = $1 AND from_seq + frame_count > $X ORDER BY from_seq
 *
 * which is exact but NOT SARGABLE: `from_seq + frame_count` is an expression over two columns,
 * so the `(message_id, from_seq)` primary key cannot be used to seek and Postgres falls back to
 * scanning every row of the message's log — on every poll tick, for every follower.
 *
 * The same answer is available in two indexed steps. `max(from_seq) WHERE from_seq <= $X` finds
 * the row that CONTAINS the cursor (a backward index seek, one row), and `from_seq >= that`
 * range-scans forward from it. Both use the PK. The first row read may start before the cursor,
 * so its leading frames are sliced off — which is the same arithmetic the docblock describes,
 * just after an indexable seek rather than instead of one.
 *
 * ── CONTIGUITY IS ENFORCED EXACTLY AS `readFrames` ENFORCES IT ──────────────────────────────
 *
 * A row whose `from_seq` is not where the walk expected it is a HOLE, and the walk STOPS there
 * and reports `truncated`. It never skips to the next row.
 *
 * This is not tidiness. Folding across a hole does not produce a slightly-wrong message; it
 * produces a confidently-wrong one — a `tool-output-available` whose `tool-input-start` fell in
 * the gap attaches to nothing, and text after the gap concatenates as though the missing tokens
 * were never spoken. Here that goes further than it does in a recovery: this content is streamed
 * to a LIVE user, one frame at a time, and they have no way to tell. Stopping and saying so lets
 * the reader reload the durable message instead.
 */

/**
 * Ceiling on what one tick materializes.
 *
 * A poll tick normally reads one or two rows — whatever the writer flushed since the last one.
 * The FIRST tick is different: it starts at seq 0 and can face the whole log of a long reply.
 * Bounded so that read is spread across several ticks rather than pulling tens of megabytes into
 * one instance's memory at once, which is the difference between a follower and an OOM after a
 * fleet-wide reconnect.
 *
 * Deliberately smaller than `readFrames`'s MAX_READ_BYTES (24 MB): that one had to reconstruct a
 * whole message in a single call, and this one simply continues on the next tick 250ms later.
 */
const MAX_TICK_BYTES = 2 * 1024 * 1024;

export interface FrameCursorRead {
  /** Frames from `fromSeq` onward, contiguous, in seq order. */
  frames: UIMessageChunk[];
  /** The cursor to pass next. Equals `fromSeq` when nothing new was found. */
  nextSeq: number;
  /**
   * The walk stopped at a HOLE. Whatever is in `frames` is still a valid contiguous prefix, but
   * the log cannot serve past it and the reader must not wait for more — it must tell the client
   * to reload the durable message.
   */
  truncated: boolean;
  /**
   * The log holds NO rows for this messageId at all.
   *
   * Distinct from "no new rows", and the distinction is what lets a follower tell a released log
   * (the stream ended and retention deleted it) from a stream that simply has not flushed since
   * the last tick. Reported as `false` on a read FAILURE, so a DB blip is never mistaken for a
   * released log.
   */
  empty: boolean;
}

const nothing = (fromSeq: number, empty: boolean): FrameCursorRead => ({
  frames: [],
  nextSeq: fromSeq,
  truncated: false,
  empty,
});

/**
 * Read the durable log from `fromSeq`.
 *
 * NEVER THROWS. A follower runs this on a timer against a stream it does not own; a read failure
 * is a tick that found nothing, and the next one tries again. It reports `empty: false` in that
 * case so the caller cannot read a transient failure as "the log was released".
 */
export const readFramesFrom = async ({
  messageId,
  fromSeq,
}: {
  messageId: string;
  fromSeq: number;
}): Promise<FrameCursorRead> => {
  // CURSOR 1 — the row containing `fromSeq`. A backward seek on the PK, one row.
  let containing: number | null;
  try {
    const [head] = await db
      .select({ fromSeq: max(aiStreamFrames.fromSeq) })
      .from(aiStreamFrames)
      .where(and(
        eq(aiStreamFrames.messageId, messageId),
        lte(aiStreamFrames.fromSeq, fromSeq),
      ));
    containing = head?.fromSeq ?? null;
  } catch (error) {
    loggers.ai.warn('frame-log-cursor: cursor seek failed', {
      messageId,
      fromSeq,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return nothing(fromSeq, false);
  }

  if (containing === null) {
    // Nothing at or before the cursor. Two very different situations, and the follower's
    // behaviour turns on which: an empty log (never written, or released after the terminal
    // message write) versus a log whose earliest row starts AFTER the cursor — a hole at the
    // front, which is unservable from here.
    try {
      const [first] = await db
        .select({ fromSeq: aiStreamFrames.fromSeq })
        .from(aiStreamFrames)
        .where(eq(aiStreamFrames.messageId, messageId))
        .orderBy(asc(aiStreamFrames.fromSeq))
        .limit(1);

      if (!first) return nothing(fromSeq, true);

      loggers.ai.warn('frame-log-cursor: log begins after the cursor — cannot serve this reader', {
        messageId,
        fromSeq,
        firstAvailableSeq: first.fromSeq,
      });
      return { frames: [], nextSeq: fromSeq, truncated: true, empty: false };
    } catch (error) {
      loggers.ai.warn('frame-log-cursor: emptiness check failed', {
        messageId,
        fromSeq,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return nothing(fromSeq, false);
    }
  }

  // CURSOR 2 — forward range scan from the containing row. Also a PK seek.
  let rows: { fromSeq: number; frameCount: number; frames: unknown[]; byteSize: number }[];
  try {
    rows = await db
      .select({
        fromSeq: aiStreamFrames.fromSeq,
        frameCount: aiStreamFrames.frameCount,
        frames: aiStreamFrames.frames,
        byteSize: aiStreamFrames.byteSize,
      })
      .from(aiStreamFrames)
      .where(and(
        eq(aiStreamFrames.messageId, messageId),
        gte(aiStreamFrames.fromSeq, containing),
      ))
      .orderBy(asc(aiStreamFrames.fromSeq));
  } catch (error) {
    loggers.ai.warn('frame-log-cursor: range read failed', {
      messageId,
      fromSeq,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return nothing(fromSeq, false);
  }

  const collected: UIMessageChunk[] = [];
  // The walk starts at the CONTAINING row's seq, not at `fromSeq` — the leading frames it
  // contributes are sliced off at the end. Starting the contiguity check at `fromSeq` instead
  // would report a hole for every ordinary mid-row cursor.
  let expectedSeq = containing;
  let truncated = false;
  let readBytes = 0;

  for (const row of rows) {
    if (row.fromSeq !== expectedSeq) {
      // A HOLE. Stop — never skip. See the module docblock: past this point the fold would be
      // confidently wrong rather than merely short, and it is being streamed to a live reader.
      loggers.ai.warn('frame-log-cursor: gap in durable frames — stopping at the hole', {
        messageId,
        expectedSeq,
        foundSeq: row.fromSeq,
      });
      truncated = true;
      break;
    }
    // Checked AFTER the contiguity test and BEFORE taking the row, so the budget bounds what is
    // materialized. Not `truncated`: the walk stopped because it had read enough, not because
    // the log is unservable, and the next tick resumes exactly here.
    if (readBytes >= MAX_TICK_BYTES && collected.length > 0) break;

    readBytes += row.byteSize;
    collected.push(...(row.frames as UIMessageChunk[]));
    // Advance by the RECORDED count, exactly as `readFrames` does. Trusting the column is what
    // makes a disagreement between it and the payload surface as a gap (and stop the walk)
    // rather than silently shifting every subsequent row's seq.
    expectedSeq = row.fromSeq + row.frameCount;
  }

  // Drop what the containing row contributed before the cursor.
  const skip = fromSeq - containing;
  const frames = skip > 0 ? collected.slice(skip) : collected;

  return {
    frames,
    nextSeq: Math.max(fromSeq, expectedSeq),
    truncated,
    empty: false,
  };
};
