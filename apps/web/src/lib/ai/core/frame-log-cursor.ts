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
 * ── THE BUDGET BOUNDS THE QUERY, NOT THE LOOP ───────────────────────────────────────────────
 *
 * An earlier version selected every row from the cursor onward and applied `MAX_TICK_BYTES`
 * while walking the result. That bounded nothing: the driver had already materialized and
 * parsed the entire remaining log — up to the writer's 64 MB per-stream durable ceiling —
 * before any JavaScript ceiling could look at it. A reconnect against a long stream, and
 * especially a fleet-wide reconnect across many streams, would allocate that per follower
 * (review finding — chatgpt-codex-connector, PR #2421). `readFrames` documents avoiding
 * exactly this and then this module reintroduced it.
 *
 * So the payload is never over-fetched. The METADATA pass reads three integers per row —
 * negligible whatever the log holds, and `LIMIT`ed besides — and the contiguous prefix and
 * the byte budget are both decided from it. The PAYLOAD pass then fetches `frames` for exactly
 * the rows that survived that decision, bounded by `from_seq <= $lastWanted`.
 *
 * It also costs LESS than the version it replaces on the common path. A tick that finds nothing
 * new — most of them, on a stream inside a tool call — now stops after the metadata query and
 * never issues the payload query at all.
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

/**
 * Ceiling on how many row HEADERS one tick inspects.
 *
 * The metadata pass is three integers per row, so this is a formality against a pathological
 * log rather than a real constraint — but it makes the first query bounded in the same
 * statement rather than in the loop that reads it, which is the whole lesson of `MAX_TICK_BYTES`
 * above. Comfortably more rows than `MAX_TICK_BYTES` can admit at any realistic batch size, so
 * the byte budget is what actually decides the prefix and this never truncates first in
 * practice. Reaching it behaves exactly like reaching the byte budget: the tick stops, and the
 * next one resumes from the cursor it left.
 */
const MAX_TICK_ROWS = 512;

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

  // PASS 1 — METADATA ONLY, forward from the containing row. Three integers per row, `LIMIT`ed:
  // this is what makes the budget below a real bound rather than a ceiling applied to something
  // the driver has already parsed into memory.
  let index: { fromSeq: number; frameCount: number; byteSize: number }[];
  try {
    index = await db
      .select({
        fromSeq: aiStreamFrames.fromSeq,
        frameCount: aiStreamFrames.frameCount,
        byteSize: aiStreamFrames.byteSize,
      })
      .from(aiStreamFrames)
      .where(and(
        eq(aiStreamFrames.messageId, messageId),
        gte(aiStreamFrames.fromSeq, containing),
      ))
      .orderBy(asc(aiStreamFrames.fromSeq))
      .limit(MAX_TICK_ROWS);
  } catch (error) {
    loggers.ai.warn('frame-log-cursor: index read failed', {
      messageId,
      fromSeq,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return nothing(fromSeq, false);
  }

  // Decide the contiguous, budgeted prefix from the metadata alone.
  //
  // The walk starts at the CONTAINING row's seq, not at `fromSeq` — the leading frames it
  // contributes are sliced off at the end. Starting the contiguity check at `fromSeq` instead
  // would report a hole for every ordinary mid-row cursor.
  let expectedSeq = containing;
  let lastWantedSeq = -1;
  let truncated = false;
  let readBytes = 0;

  for (const row of index) {
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
    // Checked AFTER the contiguity test and BEFORE the row is taken, so the budget decides what
    // the payload query will FETCH. Deliberately not `truncated`: the walk stopped because it
    // had taken enough for one tick, not because the log is unservable, and the next tick
    // resumes exactly here. The first row is always taken, so a single oversized row still makes
    // progress rather than stalling the follower forever.
    if (readBytes >= MAX_TICK_BYTES && lastWantedSeq >= 0) break;

    readBytes += row.byteSize;
    lastWantedSeq = row.fromSeq;
    // Advance by the RECORDED count, exactly as `readFrames` does. Trusting the column is what
    // makes a disagreement between it and the payload surface as a gap (and stop the walk)
    // rather than silently shifting every subsequent row's seq.
    expectedSeq = row.fromSeq + row.frameCount;
  }

  // NOTHING NEW TO FETCH. Two ways to land here, and both are ordinary rather than exceptional:
  // the very first row was a hole (`lastWantedSeq < 0`), or the admitted rows reach no further
  // than the cursor already does (`expectedSeq <= fromSeq`) — which is what EVERY tick on a
  // stream sitting in a long tool call looks like.
  //
  // Returning here is most of what makes the two-pass split cheaper than the single
  // over-fetching query it replaced rather than merely safer: the common tick now costs two
  // integer reads and never touches the `frames` jsonb at all.
  if (lastWantedSeq < 0 || expectedSeq <= fromSeq) {
    return { frames: [], nextSeq: fromSeq, truncated, empty: false };
  }

  // PASS 2 — the payload for exactly those rows, and no more.
  let rows: { fromSeq: number; frameCount: number; frames: unknown[] }[];
  try {
    rows = await db
      .select({
        fromSeq: aiStreamFrames.fromSeq,
        frameCount: aiStreamFrames.frameCount,
        frames: aiStreamFrames.frames,
      })
      .from(aiStreamFrames)
      .where(and(
        eq(aiStreamFrames.messageId, messageId),
        gte(aiStreamFrames.fromSeq, containing),
        lte(aiStreamFrames.fromSeq, lastWantedSeq),
      ))
      .orderBy(asc(aiStreamFrames.fromSeq));
  } catch (error) {
    loggers.ai.warn('frame-log-cursor: payload read failed', {
      messageId,
      fromSeq,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return nothing(fromSeq, false);
  }

  // PASS 2 RE-WALKS CONTIGUITY rather than trusting pass 1 to still describe the table —
  // the same rule `readFrames` follows, and for the same reason: between the two queries a
  // release or the retention backstop can delete this message's rows wholesale. Re-deriving here
  // makes pass 1 purely a decision about HOW MUCH to fetch, and leaves this walk the single
  // authority on what is contiguous.
  const collected: UIMessageChunk[] = [];
  let seq = containing;
  for (const row of rows) {
    if (row.fromSeq !== seq) {
      loggers.ai.warn('frame-log-cursor: log changed between the index and payload reads — stopping', {
        messageId,
        expectedSeq: seq,
        foundSeq: row.fromSeq,
      });
      truncated = true;
      break;
    }
    collected.push(...(row.frames as UIMessageChunk[]));
    seq = row.fromSeq + row.frameCount;
  }

  // Drop what the containing row contributed before the cursor.
  const skip = fromSeq - containing;
  const frames = skip > 0 ? collected.slice(skip) : collected;

  return {
    frames,
    nextSeq: Math.max(fromSeq, seq),
    truncated,
    empty: false,
  };
};
