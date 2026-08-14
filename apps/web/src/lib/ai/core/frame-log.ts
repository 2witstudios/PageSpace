import type { UIMessageChunk } from 'ai';
import { db } from '@pagespace/db/db';
import { asc, eq } from '@pagespace/db/operators';
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
 * Matches `MAX_FOLD_BYTES` in stream-lifecycle.ts deliberately — see `readFrames`.
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
 * BOUNDED, because the callers are batch loops. `reconcileDeadStreamRows` and the takeover
 * fan `materializeInterruptedStream` out with `Promise.all` over every dead row an instance
 * left behind — "potentially dozens" by their own docblocks — and each call now reads and
 * folds a whole log rather than one already-capped `parts` blob. Without a ceiling here, a
 * mass recovery's peak is dozens x the per-stream durable budget, which is how a recovery
 * sweep turns one dead instance into two (review finding — adversarial pass).
 *
 * The ceiling is the LIVE fold's, so recovering a stream costs no more than generating it did,
 * and a reader can never reconstruct more than a live client could have held. Past it the walk
 * stops and returns the prefix — which composes correctly with `recoverParts`, since a
 * truncated read simply reaches less far than the `parts` snapshot and loses the comparison
 * to it.
 *
 * WHAT IT DOES AND DOES NOT BOUND, stated precisely rather than left to be assumed. It bounds
 * what this function RETAINS and what the caller then FOLDS — the dominant cost, since the fold
 * allocates a part per frame family, reconstructs partial JSON, and grows a string. It does NOT
 * bound the SELECT: the driver has already materialized this message's rows by the time the
 * walk starts, so the transient floor is one message's whole log. That is capped in turn by the
 * writer's own `MAX_DURABLE_BYTES`, which is the honest residual — bounding it tightly would
 * need a cumulative-sum window function or a streaming cursor, and neither is worth the
 * machinery against a per-message cap that already holds.
 *
 * NEVER THROWS: a read failure returns `null`, degrading to the `parts` fallback rather than
 * failing a crash recovery that had a usable snapshot all along.
 */
export const readFrames = async (messageId: string): Promise<UIMessageChunk[] | null> => {
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
      .where(eq(aiStreamFrames.messageId, messageId))
      .orderBy(asc(aiStreamFrames.fromSeq));
  } catch (error) {
    loggers.ai.warn('frame-log: read failed', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }

  if (rows.length === 0) return null;

  const frames: UIMessageChunk[] = [];
  let expectedSeq = 0;
  let readBytes = 0;
  for (const row of rows) {
    if (readBytes >= MAX_READ_BYTES) {
      loggers.ai.warn('frame-log: read budget reached — returning the prefix read so far', {
        messageId,
        keptFrames: frames.length,
        readBytes,
      });
      break;
    }
    if (row.fromSeq !== expectedSeq) {
      loggers.ai.warn('frame-log: gap in durable frames — truncating at the hole', {
        messageId,
        expectedSeq,
        foundSeq: row.fromSeq,
        keptFrames: frames.length,
      });
      break;
    }
    frames.push(...(row.frames as UIMessageChunk[]));
    // The column the writer measured, so this costs no re-serialization.
    readBytes += row.byteSize;
    // Advance by the RECORDED count, not by `row.frames.length`. They agree for every row
    // this code writes; trusting the column is what makes a disagreement show up as a gap
    // (and truncate) rather than silently shifting every subsequent row's seq.
    expectedSeq = row.fromSeq + row.frameCount;
  }

  // A first row that did not start at seq 0 leaves nothing usable — say "no log" rather than
  // handing back an empty array the caller would read as "this stream produced nothing".
  return frames.length > 0 ? frames : null;
};
