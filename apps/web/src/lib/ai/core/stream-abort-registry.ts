/**
 * Stream Abort Registry
 *
 * Manages AbortControllers for active AI streams, enabling explicit user-initiated
 * abort while allowing streams to complete server-side on client disconnect.
 *
 * Flow:
 * 1. Server creates AbortController and registers with streamId
 * 2. streamId sent to client via response header
 * 3. Client calls abort endpoint with streamId when user clicks stop
 * 4. Server looks up controller and aborts the stream
 * 5. Cleanup happens automatically via onFinish or timeout
 */

import { createId } from '@paralleldrive/cuid2';
import { STREAM_MAX_LIFETIME_MS } from '@/lib/ai/core/stream-horizons';

interface StreamEntry {
  controller: AbortController;
  createdAt: number;
  userId: string;
  /**
   * Drives the stream's row terminal. Attached by the generation routes right after the
   * lifecycle is created (`attachStreamFinisher`) — see why it must not be left to callbacks
   * in the docblock there.
   */
  finish?: (aborted: boolean) => void;
}

const registry = new Map<string, StreamEntry>();
const messageIdToStreamId = new Map<string, string>();
const streamIdToMessageId = new Map<string, string>();

/**
 * Streams this process ran to completion, keyed by BOTH names, with the time they ended.
 *
 * WHY A TOMBSTONE AND NOT JUST A DELETE
 *
 * A generation ends well before its row does. `onFinish` unregisters the controller immediately
 * (there is nothing left to abort) and only writes the terminal status at the very END — after
 * persisting the assistant message, settling the credit hold, and billing each tool call in turn.
 * For that whole window the row still reads `status='streaming'` and its heartbeat is still fresh.
 *
 * Without a tombstone, a Stop pressed in that window — as the last tokens render, which is one of
 * the most common Stop clicks there is — looks exactly like a stream owned by ANOTHER instance:
 * the registry misses, so we would mark the row and wait for an owner that no longer exists, time
 * out against a live heartbeat, and warn the user that their agent is "still running and still
 * billing". It finished. The honest answer is that nothing is running, and the honest answer is
 * SILENT.
 *
 * So we remember, briefly, that this stream ended HERE. Long enough to outlive any settle wait,
 * far short of the heartbeat staleness window.
 */
const recentlyFinished = new Map<string, number>();

/**
 * It must outlive the tail of `onFinish` — the gap between unregistering the controller and writing
 * the terminal status, which covers message persistence, credit settlement, and a per-tool-call
 * billing loop. That tail has no tight upper bound, so a minute is not obviously enough; the whole
 * request is capped at `maxDuration` (5 min), which is.
 *
 * Erring long is cheap here and erring short is not. A tombstone can only ever suppress the
 * escalation of a name THIS process finished, and a name is never reused (messageId and streamId
 * are per-request cuid2s — and registration clears the tombstone anyway, so even a reuse is safe).
 * Whereas an expired tombstone means a Stop on a finishing stream escalates, times out against a
 * heartbeat that is still beating, and falsely warns the user their agent is still billing.
 */
const FINISHED_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

/** This process owned this stream, and it is over. Records BOTH of its names. */
const rememberFinishedHere = (streamId: string): void => {
  const now = Date.now();
  const messageId = streamIdToMessageId.get(streamId);

  recentlyFinished.set(streamId, now);
  if (messageId !== undefined) recentlyFinished.set(messageId, now);
};

const linkStream = (streamId: string, messageId: string): void => {
  // Clear any stale reverse entries before re-linking — otherwise a later
  // unlink of an orphaned half can wipe the active mapping and break
  // abortStreamByMessageId.
  const previousStreamId = messageIdToStreamId.get(messageId);
  if (previousStreamId !== undefined && previousStreamId !== streamId) {
    streamIdToMessageId.delete(previousStreamId);
  }
  const previousMessageId = streamIdToMessageId.get(streamId);
  if (previousMessageId !== undefined && previousMessageId !== messageId) {
    messageIdToStreamId.delete(previousMessageId);
  }
  messageIdToStreamId.set(messageId, streamId);
  streamIdToMessageId.set(streamId, messageId);

  // A stream that is STARTING is not a stream that finished. If either of its names carries a
  // tombstone from a previous generation, it must go now — otherwise `wasRecentlyFinishedHere`
  // would answer for the dead one, and a Stop aimed at THIS live generation would be reported as
  // "nothing in flight" and swallowed in silence, while it kept generating and kept billing. The
  // tombstone exists to prevent exactly that failure; it must not become a way to cause it.
  recentlyFinished.delete(messageId);
  recentlyFinished.delete(streamId);
};

const unlinkStream = (streamId: string): void => {
  const messageId = streamIdToMessageId.get(streamId);
  if (messageId === undefined) return;
  streamIdToMessageId.delete(streamId);
  messageIdToStreamId.delete(messageId);
};

// Safety net for orphaned entries only — a stream that ends normally unregisters itself.
// Shares STREAM_MAX_LIFETIME_MS with the multicast registry and the heartbeat cap: if this
// were shorter, a still-running long generation would be reported as live by
// /active-streams while its Stop button had already become a no-op here.
const MAX_STREAM_AGE_MS = STREAM_MAX_LIFETIME_MS;
const CLEANUP_INTERVAL_MS = 60 * 1000;

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

const startCleanupInterval = () => {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [streamId, entry] of registry.entries()) {
      if (now - entry.createdAt > MAX_STREAM_AGE_MS) {
        registry.delete(streamId);
        unlinkStream(streamId);
      }
    }
    for (const [name, finishedAt] of recentlyFinished.entries()) {
      if (now - finishedAt > FINISHED_TOMBSTONE_TTL_MS) recentlyFinished.delete(name);
    }
  }, CLEANUP_INTERVAL_MS);
};

/**
 * Create and register a new AbortController for a stream
 * Returns the streamId and AbortSignal to use with streamText
 *
 * @param userId - The ID of the user who owns this stream (required for security)
 * @param streamId - Optional custom stream ID (defaults to auto-generated cuid2)
 */
export const createStreamAbortController = ({
  userId,
  streamId = createId(),
  messageId,
}: {
  userId: string;
  streamId?: string;
  messageId?: string;
}): {
  streamId: string;
  signal: AbortSignal;
  controller: AbortController;
} => {
  startCleanupInterval();

  const controller = new AbortController();
  registry.set(streamId, {
    controller,
    createdAt: Date.now(),
    userId,
  });

  // This stream is starting, so it is not finished — whatever a tombstone from a previous
  // generation may say. `linkStream` clears both names, but it only runs when a messageId was
  // given, so the streamId is cleared here too.
  recentlyFinished.delete(streamId);

  if (messageId) {
    linkStream(streamId, messageId);
  }

  return {
    streamId,
    signal: controller.signal,
    controller,
  };
};

/**
 * Attach the stream's terminal write to its registry entry, so that aborting the stream and
 * recording that it stopped are ONE act.
 *
 * WHY THIS IS NOT LEFT TO onAbort/onFinish
 *
 * It looks redundant: the generation routes already call `lifecycle.finish(true)` from
 * `streamText`'s `onAbort`. But both routes document, in their own comments, that those hooks are
 * not reachable on every path:
 *
 *   - "onAbort only fires while a streamText is live" — an abort during the inter-attempt retry
 *     backoff, or before the first streamText is built, is never seen by it.
 *   - "onFinish is coupled to the response stream and may never fire when the mobile client
 *     backgrounds mid-stream" — which is EXACTLY the population of a cross-instance abort. The
 *     whole reason streams are server-owned is that the client went away.
 *
 * Before this change that was survivable: the row would sit at 'streaming' until its heartbeat
 * went stale and the next takeover reconciled it. It is not survivable now. A cross-instance
 * abort WAITS for the row to go terminal to decide what to tell the user, so a stopped stream
 * whose row never settles would be reported as "still running, still billing" — a false alarm on
 * the one message that must never be false.
 *
 * So the terminal write rides the abort itself. `lifecycle.finish` is idempotent, so the ordinary
 * onAbort path is unaffected.
 */
export const attachStreamFinisher = ({
  streamId,
  finish,
}: {
  streamId: string;
  finish: (aborted: boolean) => void;
}): void => {
  const entry = registry.get(streamId);
  if (!entry) return;
  entry.finish = finish;
};

/**
 * Every stream this process owns — i.e. whose AbortController lives in THIS instance's registry.
 *
 * The cross-instance abort watcher needs this to know which marked rows are its own to act on.
 * Only streams registered with a messageId appear (both generation routes always pass one).
 */
export const listLocalStreams = (): { messageId: string; streamId: string; userId: string }[] => {
  const streams: { messageId: string; streamId: string; userId: string }[] = [];
  for (const [messageId, streamId] of messageIdToStreamId.entries()) {
    const entry = registry.get(streamId);
    if (!entry) continue;
    streams.push({ messageId, streamId, userId: entry.userId });
  }
  return streams;
};

/**
 * Abort a stream by its ID
 * Returns true if stream was found and aborted, false if not found
 *
 * @param streamId - The ID of the stream to abort
 * @param userId - The ID of the user requesting the abort (must match stream owner)
 */
export const abortStream = ({
  streamId,
  userId,
}: {
  streamId: string;
  userId: string;
}): { aborted: boolean; reason: string } => {
  const entry = registry.get(streamId);

  if (!entry) {
    return { aborted: false, reason: 'Stream not found or already completed' };
  }

  // SECURITY: Verify the requesting user owns this stream (prevents IDOR attacks).
  //
  // This is the LAST of three independent checks on the cross-instance path, and it is not
  // redundant: the mark can only be written by a UPDATE carrying the caller's user id, and the
  // watcher refuses to act unless the row's owner matches this entry's. This one holds the line
  // if either of those is ever weakened.
  if (entry.userId !== userId) {
    return { aborted: false, reason: 'Unauthorized to abort this stream' };
  }

  entry.controller.abort();

  // Tombstone BEFORE unlinking, while the messageId is still reachable from the streamId.
  //
  // An abort ends the stream here just as surely as a natural finish does, and it leaves the same
  // window: the terminal write is fire-and-forget, so the row still reads 'streaming' with a fresh
  // heartbeat for a moment afterwards. A SECOND Stop naming that stream (a double-click, or one of
  // the surfaces that aborts by messageId) would otherwise miss the registry, find no tombstone,
  // escalate, and time out against that live heartbeat — warning the user that a generation is
  // "still running and still billing" seconds after we killed it ourselves.
  rememberFinishedHere(streamId);

  registry.delete(streamId);
  unlinkStream(streamId);

  // Record that it stopped, as part of stopping it. See `attachStreamFinisher`.
  entry.finish?.(true);

  return { aborted: true, reason: 'Stream aborted by user request' };
};

/**
 * Remove a stream from the registry (call in onFinish).
 *
 * Records a tombstone: this process OWNED this stream and it is over. See `recentlyFinished` — a
 * Stop arriving in the window between here and the terminal write must be told "nothing is
 * running" (silent), not mistaken for a stream living on another instance (a loud, false "still
 * billing" alarm).
 */
export const removeStream = ({ streamId }: { streamId: string }): void => {
  rememberFinishedHere(streamId);
  registry.delete(streamId);
  unlinkStream(streamId);
};

/**
 * Did a stream by this name run to completion on THIS instance, recently?
 *
 * The question a cross-instance abort must ask before escalating. A registry miss alone cannot
 * distinguish "it finished here moments ago" from "it belongs to another instance" — and those two
 * demand opposite answers: silence, versus marking the row and waiting for an owner.
 */
export const wasRecentlyFinishedHere = ({
  messageId,
  streamId,
}: {
  messageId?: string;
  streamId?: string;
}): boolean => {
  const now = Date.now();
  for (const name of [messageId, streamId]) {
    if (name === undefined) continue;
    const finishedAt = recentlyFinished.get(name);
    if (finishedAt !== undefined && now - finishedAt <= FINISHED_TOMBSTONE_TTL_MS) return true;
  }
  return false;
};

export const abortStreamByMessageId = ({
  messageId,
  userId,
}: {
  messageId: string;
  userId: string;
}): { aborted: boolean; reason: string } => {
  const streamId = messageIdToStreamId.get(messageId);
  if (!streamId) {
    return { aborted: false, reason: 'Stream not found or already completed' };
  }
  return abortStream({ streamId, userId });
};

/**
 * Check if a stream is registered and active
 */
export const isStreamActive = ({ streamId }: { streamId: string }): boolean => {
  return registry.has(streamId);
};

/**
 * Get the count of active streams (for monitoring/debugging)
 */
export const getActiveStreamCount = (): number => {
  return registry.size;
};

// Header name for passing stream ID to client
export const STREAM_ID_HEADER = 'X-Stream-Id';
