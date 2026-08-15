import type { UIMessageChunk } from 'ai';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { openStreamChannel, type StreamChannel } from '@/lib/ai/core/stream-channel';
import { readFramesFrom } from '@/lib/ai/core/frame-log-cursor';
import { STREAM_MAX_LIFETIME_MS } from '@/lib/ai/core/stream-horizons';

/**
 * Follow a generation owned by ANOTHER web instance, by tailing its durable frame log — and
 * present it as an ordinary `StreamChannel`.
 *
 * ── THE SHAPE IS THE WHOLE DESIGN ───────────────────────────────────────────────────────────
 *
 * The obvious implementation is a second branch in the SSE route: if remote, poll and write
 * frames. That would fork the route body, and the fork would then have to re-implement — and
 * keep in step with — the SSE framing, the 20s ping, the 5s permission recheck, the teardown on
 * client abort, and the `overflow` / `resumeFromSeq` semantics. Five behaviours, two copies,
 * one of which nobody exercises locally.
 *
 * So this produces a real `StreamChannel` instead: an ordinary `openStreamChannel`, with a
 * poller as its only writer where a generation would have had a pump. `subscribe`, `onFrame`,
 * `onEnd`, the ring, eviction, backpressure and the end reasons are then LITERALLY the same
 * code, and the route cannot tell a followed stream from a local one.
 *
 * ── IT ALWAYS STARTS AT SEQ 0 ───────────────────────────────────────────────────────────────
 *
 * Not at the first subscriber's cursor. A channel that began at seq 40 would answer `overflow`
 * to every OTHER subscriber that arrives with a lower cursor — including the common case of a
 * second tab on the same reply — and `overflow` is a reseed, not a resume. Starting at 0 makes
 * the channel servable from any cursor, at the cost of one initial read that the tick budget
 * (`frame-log-cursor.ts`) already bounds.
 *
 * ── REFCOUNTED PER messageId ────────────────────────────────────────────────────────────────
 *
 * Co-located tabs watching one remote reply share ONE poller. Without this, N tabs on one
 * instance is N pollers against the same rows, and the load a follower puts on Postgres scales
 * with viewers rather than with streams.
 */

/**
 * Poll cadence while frames are arriving.
 *
 * Matched to the WRITER, not to a latency target. `frame-log-writer` flushes at 64 frames /
 * 200ms / 256 KB, so polling faster than its flush interval cannot see fresher data — it only
 * spends round trips discovering that nothing changed. 250ms sits just past a flush period, so
 * a follower is typically one flush behind, which is where the ~300ms incremental figure comes
 * from (against ~1200ms for the whole-array snapshot polling this replaces).
 */
const POLL_INTERVAL_MS = 250;

/**
 * Cadence after the stream goes quiet.
 *
 * A generation inside a long tool call emits nothing for minutes. At the fast cadence that is
 * four wasted queries a second, per followed stream, for the length of the tool call.
 */
const IDLE_POLL_INTERVAL_MS = 1000;

/** Empty ticks before backing off. Small, so a brief pause between flushes does not slow the
 *  common case, and the backoff resets on the very next frame. */
const EMPTY_TICKS_BEFORE_BACKOFF = 4;

/**
 * The frames that PROVE the log holds a whole generation.
 *
 * A NON-EMPTY LOG IS NOT A COMPLETE ONE, and conflating them was a real bug. `frame-log-writer`
 * has three documented ways to stop early — its pre-write delete failing, a batch insert
 * failing, and exhausting the per-stream durable budget — and every one of them leaves a valid,
 * contiguous, HOLE-FREE prefix behind. A follower that delivered such a prefix and then found
 * the row terminal would see `empty: false` and `truncated: false`, hand the client a clean
 * `done`, and — because frames HAD been delivered — leave `joinFailed` false too. The user would
 * be left looking at a truncated reply that nothing ever reloaded, with no signal anywhere that
 * it was short (review finding — chatgpt-codex-connector, PR #2421).
 *
 * The log has no length marker to check against, and `raw_parts_count` — the comparator
 * `materializeInterruptedStream` uses for exactly this question — is zeroed by the terminal
 * write, so it is gone by the time a follower needs it. But the STREAM carries its own
 * terminator: `pumpSdkStreamToChannel` appends every SDK frame verbatim, so a log that contains
 * one contains everything the generation produced. `finish` ends a normal turn, `abort` a
 * stopped one, and `error` is the synthetic frame the pump appends when the SDK stream throws —
 * after which it stops reading. Any of the three is proof that capture ran to the end.
 *
 * Deliberately "have we EVER seen one" rather than "is the last frame one": a trailing
 * `message-metadata` frame would defeat the stricter test, and the cost of being wrong differs
 * enormously by direction. Failing to recognise completeness costs one needless reload; falsely
 * claiming it is the silent truncation above.
 */
const STREAM_TERMINATOR_FRAMES: ReadonlySet<string> = new Set(['finish', 'abort', 'error']);

/**
 * How long a channel outlives its last subscriber.
 *
 * A tab reconnecting (a network blip, a `resumeFromSeq` reseed, a pane remounting) would
 * otherwise pay for a cold start — a fresh read from seq 0 — for a stream this instance was
 * following moments ago. Short enough that an abandoned follower stops polling promptly.
 */
const LINGER_MS = 5000;

export interface RemoteChannelHandle {
  /** Indistinguishable from a locally-owned channel, by construction. */
  channel: StreamChannel;
  /** Drop this holder's reference. Idempotent. */
  release: () => void;
}

interface Follower {
  channel: StreamChannel;
  refs: number;
  cursor: number;
  emptyTicks: number;
  /** A stream terminator has reached this channel — see STREAM_TERMINATOR_FRAMES. Until it has,
   *  a non-empty log is not evidence of a complete one. */
  sawTerminator: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  evictionTimer: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

const followers = new Map<string, Follower>();

/** The owning instance's own verdict on whether the generation is over. */
const readTerminalState = async (
  messageId: string,
): Promise<{ present: boolean; terminal: boolean; aborted: boolean }> => {
  try {
    const [row] = await db
      .select({ status: aiStreamSessions.status })
      .from(aiStreamSessions)
      .where(eq(aiStreamSessions.messageId, messageId))
      .limit(1);

    if (!row) return { present: false, terminal: true, aborted: true };
    if (row.status === 'streaming') return { present: true, terminal: false, aborted: false };
    return { present: true, terminal: true, aborted: row.status === 'aborted' };
  } catch (error) {
    // Unreadable is NOT terminal. Ending the channel on a DB blip would tell every viewer the
    // reply had finished while it was still being generated — the exact failure this whole
    // workstream exists to end.
    loggers.ai.warn('remote-frame-follower: could not read terminal state', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { present: true, terminal: false, aborted: false };
  }
};

/** Append frames and record whether any of them ended the stream. */
const deliver = (follower: Follower, frames: readonly UIMessageChunk[]): void => {
  for (const chunk of frames) {
    follower.channel.append(chunk);
    if (STREAM_TERMINATOR_FRAMES.has(chunk.type)) follower.sawTerminator = true;
  }
};

const stop = (messageId: string, follower: Follower): void => {
  if (follower.stopped) return;
  follower.stopped = true;
  if (follower.pollTimer !== null) clearTimeout(follower.pollTimer);
  if (follower.lingerTimer !== null) clearTimeout(follower.lingerTimer);
  clearTimeout(follower.evictionTimer);
  if (followers.get(messageId) === follower) followers.delete(messageId);
};

/**
 * End the followed channel, and say honestly WHY.
 *
 * Three answers, and they are genuinely different to the reader. `stream-lifecycle` deletes the
 * frames on its terminal write, so "the row is over" and "the frames are still there" are
 * independent facts, and collapsing them is what would make a followed reply silently shorter
 * than the one the originating tab saw.
 */
const finishFollower = (
  messageId: string,
  follower: Follower,
  { aborted, truncated }: { aborted: boolean; truncated: boolean },
): void => {
  stop(messageId, follower);
  try {
    follower.channel.finish(aborted, { truncated });
  } catch (error) {
    loggers.ai.warn('remote-frame-follower: channel finish threw', {
      messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};

const schedule = (messageId: string, follower: Follower, delayMs: number): void => {
  if (follower.stopped) return;
  follower.pollTimer = setTimeout(() => {
    void tick(messageId, follower);
  }, delayMs);
  follower.pollTimer.unref?.();
};

const tick = async (messageId: string, follower: Follower): Promise<void> => {
  if (follower.stopped) return;

  const read = await readFramesFrom({ messageId, fromSeq: follower.cursor });
  if (follower.stopped) return;

  if (read.frames.length > 0) {
    deliver(follower, read.frames);
    follower.cursor = read.nextSeq;
    // Reset on ANY new frame — the backoff is about quiet streams, and a stream that spoke is
    // not quiet. Without this a reader that fell into the idle cadence during one long tool call
    // would stay four times slower for the rest of a chatty reply.
    follower.emptyTicks = 0;
  }

  if (read.truncated) {
    // A hole, or a log that begins after this channel's cursor. Nothing further can be served
    // from here and there is no seq to resume from — the reader must reload the durable message.
    // Whatever was appended before the hole stays: it is a valid prefix, and it is what a client
    // that disconnected at that seq would have.
    finishFollower(messageId, follower, { aborted: false, truncated: true });
    return;
  }

  if (read.frames.length > 0) {
    // Frames arrived, so the generation was alive as of this read. Deliberately NOT paying for
    // the status query — that is the whole reason the status read is on the empty branch only.
    schedule(messageId, follower, POLL_INTERVAL_MS);
    return;
  }

  follower.emptyTicks += 1;

  // Only a tick that found NOTHING asks whether the stream is over. A tick that found frames has
  // already answered it, and a status read per frame batch would double this follower's query
  // rate for no information at all.
  const state = await readTerminalState(messageId);
  if (follower.stopped) return;

  if (state.terminal) {
    if (!state.present) {
      // The row is GONE — a conversation hard-deleted mid-follow, or a retention sweep. Not
      // "finished", and not resumable: nothing durable remains to reload from either, so the
      // reader is told its copy is incomplete rather than being handed a clean end.
      finishFollower(messageId, follower, { aborted: true, truncated: true });
      return;
    }

    // The row is terminal. One last read, because frames can land between the tick that found
    // nothing and the status query that answered.
    const tail = await readFramesFrom({ messageId, fromSeq: follower.cursor });
    if (follower.stopped) return;

    if (tail.frames.length > 0) {
      deliver(follower, tail.frames);
      follower.cursor = tail.nextSeq;
    }

    // A CLEAN END REQUIRES PROOF, not merely the absence of evidence to the contrary.
    //
    //   - `tail.empty` — the log was RELEASED. `stream-lifecycle` deletes the frames once the
    //     terminal `messages` row is confirmed, so the reply is durably saved and this follower
    //     cannot show it delivered all of it. (Reported only for a log with no rows AT ALL,
    //     never for a failed read — see `FrameCursorRead.empty` — so a DB blip cannot
    //     masquerade as a released log and send every viewer into a needless reload.)
    //   - `tail.truncated` — a hole, or a log that begins after this cursor.
    //   - `!sawTerminator` — the log survives and is hole-free, but no `finish`/`abort`/`error`
    //     ever arrived, so the writer stopped early and this is a PREFIX. See
    //     STREAM_TERMINATOR_FRAMES: without this clause a short log reads exactly like a
    //     complete one.
    finishFollower(messageId, follower, {
      aborted: state.aborted,
      truncated: tail.truncated || tail.empty || !follower.sawTerminator,
    });
    return;
  }

  schedule(
    messageId,
    follower,
    follower.emptyTicks >= EMPTY_TICKS_BEFORE_BACKOFF ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
  );
};

/**
 * Take a reference to this messageId's follower, starting one if none is running.
 *
 * The caller MUST `release()` — the SSE route does so in the same teardown that unsubscribes.
 */
export const acquireRemoteChannel = (messageId: string): RemoteChannelHandle => {
  const existing = followers.get(messageId);
  if (existing) {
    existing.refs += 1;
    // Cancel a linger in progress: this stream has a viewer again, and the poller it already
    // has is warmer than a cold restart from seq 0 would be.
    if (existing.lingerTimer !== null) {
      clearTimeout(existing.lingerTimer);
      existing.lingerTimer = null;
    }
    return { channel: existing.channel, release: releaser(messageId, existing) };
  }

  const channel = openStreamChannel({ messageId });
  const follower: Follower = {
    channel,
    refs: 1,
    // ALWAYS 0. See the module docblock: a channel that started at a subscriber's cursor would
    // answer `overflow` to every other subscriber below it.
    cursor: 0,
    emptyTicks: 0,
    sawTerminator: false,
    pollTimer: null,
    lingerTimer: null,
    // Leak backstop, sharing STREAM_MAX_LIFETIME_MS with the channel registry, the abort
    // registry and the heartbeat cap — see stream-horizons.ts for why those must not drift.
    // Past this horizon nothing else in the system will serve this stream either, so a follower
    // still polling for it is holding a timer and a ring for a stream nobody can act on.
    evictionTimer: setTimeout(() => {
      const current = followers.get(messageId);
      if (current) finishFollower(messageId, current, { aborted: false, truncated: true });
    }, STREAM_MAX_LIFETIME_MS),
    stopped: false,
  };
  follower.evictionTimer.unref?.();
  followers.set(messageId, follower);

  // First read immediately rather than after a tick: the subscriber that just arrived is
  // waiting on the reply's existing content, and 250ms of blank bubble is the one latency a
  // reader actually notices.
  void tick(messageId, follower);

  return { channel, release: releaser(messageId, follower) };
};

const releaser = (messageId: string, follower: Follower): (() => void) => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    follower.refs -= 1;
    if (follower.refs > 0 || follower.stopped) return;

    // LINGER rather than stop. A reconnect — a network blip, a reseed, a pane remounting —
    // would otherwise pay for a cold read from seq 0 for a stream this instance was following a
    // moment ago.
    follower.lingerTimer = setTimeout(() => {
      const current = followers.get(messageId);
      if (current === follower && follower.refs <= 0) stop(messageId, follower);
    }, LINGER_MS);
    follower.lingerTimer.unref?.();
  };
};

/** Test-only. Module state otherwise leaks across cases. */
export const resetRemoteFrameFollowers = (): void => {
  for (const [messageId, follower] of [...followers.entries()]) stop(messageId, follower);
  followers.clear();
};
