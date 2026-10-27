import type { UIMessageChunk } from 'ai';
import { db } from '@pagespace/db/db';
import { and, asc, eq, lte } from '@pagespace/db/operators';
import { aiStreamFrames } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * The durable frame log's DB primitives — the only module that talks to `ai_stream_frames`
 * from the generation path.
 *
 * WHAT THIS TABLE IS FOR. The stream channel (`stream-channel.ts`) is in memory only. When
 * the owning Node process dies — a deploy, an OOM, a host migration — its frames die with
 * it, and the only durable mid-stream copy was `ai_stream_sessions.parts`: a periodically
 * REWRITTEN folded snapshot, bounded by the memory ring it was folded from. That shape has
 * two costs this table exists to remove. It rewrites the whole converged parts array roughly
 * once a second, which is O(n²) in message size over a turn; and once a long reply evicted
 * its oldest frames from the ring, the snapshot silently lost its beginning.
 *
 * So: APPEND-ONLY, and that is the design constraint, not an implementation detail. Every
 * frame is serialized once, written once, and never updated. There are exactly two writes
 * here — an INSERT of a batch, and a DELETE of a whole message's log — and no UPDATE at all.
 * A future change that rewrites a row has misunderstood the table.
 *
 * SEQ NUMBERS FRAMES, NOT ROWS. A row covers `[from_seq, from_seq + frame_count)`. The
 * primary key is `(message_id, from_seq)`, so a batch can only ever be written once, and two
 * generations on one messageId cannot interleave — the second deletes the first's log before
 * writing (see `deleteFrames`, and the re-registration path in `frame-log-writer.ts`).
 */

/**
 * Ceiling on how much of one message's log a single read will materialize.
 *
 * The same number as `MAX_FOLD_BYTES` in stream-lifecycle.ts, so a recovery costs no more
 * memory than the generation did — but measured in a different unit, which is worth saying
 * rather than leaving to be discovered. This counts the exact UTF-8 `byte_size` the writer
 * recorded; the fold counts `estimateFrameBytes`, which pads each frame by 64. The read budget
 * is therefore the marginally more permissive of the two, and `recoverParts`' length
 * comparison degrades safely whichever way they land.
 */
const MAX_READ_BYTES = 24 * 1024 * 1024;

/** A batch of frames destined for one row. */
export interface FrameBatch {
  messageId: string;
  conversationId: string;
  fromSeq: number;
  frames: UIMessageChunk[];
}

/**
 * Append one batch. Resolves `true` when the row landed.
 *
 * NEVER THROWS. A durability write that takes down the generation it was recording would be
 * strictly worse than no durability at all — the frame log is a safety net, and a safety net
 * that can drop the acrobat is not one. The caller (`frame-log-writer.ts`) uses the boolean
 * to decide whether the log is still trustworthy for this stream.
 *
 * `byteSize` is measured EXACTLY, by serializing the batch once here rather than summing the
 * channel's per-frame estimate. The estimate is deliberately cheap and approximate (it reads
 * `delta`/`text` directly and only falls back to `JSON.stringify` for the rare structural
 * frame), which is right for a hot-path budget and wrong for a column whose whole job is to
 * say how much durable storage this stream is using. One serialization per BATCH is
 * affordable; one per frame — on every token — would not be.
 *
 * And it is measured in UTF-8 BYTES, not string length. `String.prototype.length` counts
 * UTF-16 code units, which equals the byte count only for ASCII: an accented Latin character
 * costs 2 bytes, most CJK 3, an emoji 4, and each of those counts as 1 (or 2) code units. A
 * column named `byte_size` that silently undercounts every non-English reply by up to 3x is
 * not a storage metric, it is a misleading one — and this is the number a future per-stream
 * durable quota would be enforced from (review finding — coderabbitai, PR #2409).
 */
export const appendFrameBatch = async (batch: FrameBatch): Promise<boolean> => {
  try {
    const byteSize = Buffer.byteLength(JSON.stringify(batch.frames), 'utf8');
    await db.insert(aiStreamFrames).values({
      messageId: batch.messageId,
      conversationId: batch.conversationId,
      fromSeq: batch.fromSeq,
      frameCount: batch.frames.length,
      frames: batch.frames,
      byteSize,
    });
    return true;
  } catch (error) {
    loggers.ai.warn('frame-log: batch insert failed', {
      messageId: batch.messageId,
      fromSeq: batch.fromSeq,
      frameCount: batch.frames.length,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
};

/**
 * Drop a message's whole frame log. Resolves `true` when the DELETE ran.
 *
 * Two callers, one meaning: this messageId's durable record is void. Retention calls it once
 * the terminal message write is confirmed (the frames have served their purpose), and the
 * writer calls it before recording a re-registered messageId (a retry or takeover), because
 * a log holding two generations' frames under one messageId replays them spliced together —
 * a message that never existed.
 *
 * NEVER THROWS, for the same reason as the insert. A failed delete is reclaimed by the
 * retention backstop; a thrown one would break whatever path was mid-cleanup.
 */
export const deleteFrames = async (messageId: string): Promise<boolean> => {
  try {
    await db.delete(aiStreamFrames).where(eq(aiStreamFrames.messageId, messageId));
    return true;
  } catch (error) {
    loggers.ai.warn('frame-log: delete failed', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
};

/**
 * Read a message's durable frames, in seq order, as a CONTIGUOUS PREFIX from seq 0.
 *
 * Returns `null` when the log holds nothing for this messageId — which is a real and
 * expected state, not an error: a stream started by a worker from before this table had a
 * writer leaves no frames at all, and so does one whose frames were already released. The
 * caller falls back to the `parts` snapshot. `null` and `[]` therefore mean different things
 * and must not be collapsed: `[]` would be "this stream produced nothing", which would
 * materialize an empty reply over a snapshot that had content.
 *
 * WHY THE PREFIX IS ENFORCED RATHER THAN ASSUMED. Batches are written by a single writer in
 * ascending seq order, so the rows are normally gapless. But a batch insert can fail (it
 * logs and returns false rather than throwing), and if the writer kept going after one, the
 * rows would carry a HOLE. Folding across a hole does not produce a slightly-wrong message;
 * it produces a confidently-wrong one — a `tool-output-available` whose `tool-input-start`
 * fell in the gap attaches to nothing, and text after the gap concatenates as though the
 * missing tokens were never spoken. A truncated prefix is the honest answer: it is exactly
 * what a client that disconnected at that seq would have seen. The writer additionally stops
 * at its first failed batch, so this is defence in depth rather than the primary guard.
 *
 * BOUNDED IN TWO QUERIES, and the split is the whole reason this is not one. The callers are
 * batch loops: `reconcileDeadStreamRows` and the takeover fan `materializeInterruptedStream`
 * out with `Promise.all` over every dead row an instance left behind — "potentially dozens" by
 * their own docblocks — and each call reads and folds a whole log rather than one
 * already-capped `parts` blob. A single `SELECT` with the budget applied afterwards does NOT
 * bound that: the driver has already materialized and parsed every row of the log before any
 * JavaScript ceiling can look at it, so peak stays at dozens x the per-stream durable budget,
 * which is how a recovery sweep turns one dead instance into two (review finding — adversarial
 * pass; an earlier version of this code did exactly that and said otherwise).
 *
 * So the payload is never over-fetched. The first query reads only the row METADATA — three
 * integers per row, tens of rows, negligible whatever the log holds — and the contiguous
 * prefix and the byte budget are both decided from it. The second fetches `frames` for exactly
 * the rows that survived that decision. One extra round trip, on a path that only runs when a
 * process has already died.
 *
 * The ceiling is the LIVE fold's, so recovering a stream costs no more than generating it did,
 * and a reader can never reconstruct more than a live client could have held. Past it the walk
 * stops and returns the prefix — which composes correctly with `recoverParts`, since a
 * truncated read simply reaches less far than the `parts` snapshot and loses the comparison
 * to it.
 *
 * NEVER THROWS: a read failure returns `null`, degrading to the `parts` fallback rather than
 * failing a crash recovery that had a usable snapshot all along.
 */
export const readFrames = async (messageId: string): Promise<UIMessageChunk[] | null> => {
  // PASS 1 — metadata only. Three integers per row: this is what makes the budget below a real
  // bound rather than a ceiling applied to something already in memory.
  let index: { fromSeq: number; frameCount: number; byteSize: number }[];
  try {
    index = await db
      .select({
        fromSeq: aiStreamFrames.fromSeq,
        frameCount: aiStreamFrames.frameCount,
        byteSize: aiStreamFrames.byteSize,
      })
      .from(aiStreamFrames)
      .where(eq(aiStreamFrames.messageId, messageId))
      .orderBy(asc(aiStreamFrames.fromSeq));
  } catch (error) {
    loggers.ai.warn('frame-log: read failed', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }

  if (index.length === 0) return null;

  // Decide the contiguous, budgeted prefix from the metadata alone.
  let expectedSeq = 0;
  let readBytes = 0;
  let lastWantedSeq = -1;
  // Counted, not derived from `lastWantedSeq`: seq numbers FRAMES, not rows, so that value is a
  // frame offset and using it as a row count misreports every multi-frame batch — which is the
  // normal case (review finding — coderabbitai, PR #2409).
  let keptRows = 0;
  for (const row of index) {
    // Checked BEFORE the row is taken, so the budget bounds what gets fetched. The first row is
    // always taken — a single oversized row still yields frames rather than a spurious `null` —
    // and overshoot is bounded by one row.
    if (readBytes >= MAX_READ_BYTES) {
      loggers.ai.warn('frame-log: read budget reached — fetching only the prefix within it', {
        messageId,
        keptRows,
        // `expectedSeq` has advanced by each accepted row's `frame_count`, so it IS the frame
        // total — the number the row count above cannot express.
        keptFrames: expectedSeq,
        readBytes,
      });
      break;
    }
    if (row.fromSeq !== expectedSeq) {
      loggers.ai.warn('frame-log: gap in durable frames — truncating at the hole', {
        messageId,
        expectedSeq,
        foundSeq: row.fromSeq,
      });
      break;
    }
    readBytes += row.byteSize;
    lastWantedSeq = row.fromSeq;
    keptRows += 1;
    // Advance by the RECORDED count, not by any payload length. Trusting the column is what
    // makes a disagreement show up as a gap (and truncate) rather than silently shifting every
    // subsequent row's seq.
    expectedSeq = row.fromSeq + row.frameCount;
  }

  // Nothing usable — the log's earliest surviving row is not seq 0. Say "no log" rather than
  // handing back an empty array the caller would read as "this stream produced nothing".
  if (lastWantedSeq < 0) return null;

  // PASS 2 — the payload for exactly those rows.
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
        lte(aiStreamFrames.fromSeq, lastWantedSeq),
      ))
      .orderBy(asc(aiStreamFrames.fromSeq));
  } catch (error) {
    loggers.ai.warn('frame-log: frame payload read failed', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }

  // PASS 2 RE-WALKS CONTIGUITY, rather than trusting the pass above to still describe the
  // table. Correctness must not depend on two queries agreeing: between them a release or the
  // retention backstop can delete this message's rows wholesale, and — were a messageId ever
  // re-registered — a successor could replace them with its own generation's. Re-deriving the
  // prefix here makes pass 1 purely a decision about HOW MUCH to fetch, and leaves this walk
  // the single authority on what is contiguous. A vanished log then yields `null` (fall back
  // to `parts`) and a replaced one yields ITS valid prefix, instead of either silently
  // producing a spliced message.
  const frames: UIMessageChunk[] = [];
  let seq = 0;
  for (const row of rows) {
    if (row.fromSeq !== seq) {
      loggers.ai.warn('frame-log: log changed between the index and payload reads — truncating', {
        messageId,
        expectedSeq: seq,
        foundSeq: row.fromSeq,
      });
      break;
    }
    frames.push(...(row.frames as UIMessageChunk[]));
    seq = row.fromSeq + row.frameCount;
  }

  return frames.length > 0 ? frames : null;
};
