/**
 * THE APP-WIDE STREAM WRITER — one subscription per live generation, owned by the module and
 * not by any component.
 *
 * ── THE SENTENCE THIS EXISTS TO MAKE TRUE ─────────────────────────────────────────────────
 *
 * "Send a message and leave." A user sends in conversation A, navigates away, closes the
 * pane, switches to the sidebar — and the reply keeps arriving, keeps rendering, and is
 * complete when they come back. Nothing about that should depend on a React component
 * staying mounted, because from the user's point of view they asked an agent a question, not
 * a pane.
 *
 * It was not true before, and the reason was structural rather than a bug: the thing reading
 * the stream was a component's `useEffect`. `useChannelStreamSocket` opened its SSE joins
 * inside an effect keyed on `[socket, channelId, bootstrapConversationId]`, and its cleanup
 * aborted every controller and — when it was the last subscriber — ran
 * `clearPageStreams(channelId)`. So unmounting killed the reads. A whole apparatus grew to
 * paper over that: `channelStreamSubscribers` counted mounts so the LAST one could clear the
 * store, `bootstrapConsumerGuard` claimed a messageId so co-mounted panes would not both
 * join, and `channelRebootstrapSignal` nudged a surviving sibling to re-adopt the claim the
 * unmounting one had just dropped. Three modules of hand-off protocol, all of it in service
 * of a subscription that should never have been mount-scoped at all.
 *
 * Move the subscription out of the component tree and every one of those problems stops
 * existing. There is nothing to claim (the registry is the only joiner), nothing to hand off
 * (it never lets go), and nothing to count (the store entry's life is the stream's life, not
 * a mount's).
 *
 * ── WHAT "REFCOUNTED" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
 *
 * `open()` is idempotent per messageId and counts its callers, so a bootstrap, a
 * `chat:stream_start`, and a send's own admission envelope can all announce the same stream
 * and only ONE join opens. That is the whole of it.
 *
 * The count does NOT gate teardown. There is no `release()` that can close a session, and
 * that absence is the design: a component unmounting is not evidence about whether a
 * generation is still running, and every version of this that let a mount count reach zero
 * ended the same way — the store entry vanished, `deriveStreamingRegistrations` dropped the
 * editing-store registration, SWR revalidated, and the reply the server was still generating
 * disappeared off the screen. A session ends when the STREAM ends: a completion frame, a
 * `chat:stream_complete`, an access revocation, or the expiry sweep below. Never a render.
 *
 * ── THE FAILURE MODE THIS DESIGN INTRODUCES, AND THE SWEEP THAT ANSWERS IT ────────────────
 *
 * Making entries outlive components means an entry can now outlive its stream's completion
 * SIGNAL. `chat:stream_complete` is a best-effort broadcast (`broadcastAiStreamComplete` is
 * fire-and-forget with a swallowed catch) and the SSE join can die on a network drop, so
 * "nothing ever told us it ended" is a real state, not a hypothetical.
 *
 * Under the old mount-scoped design that state self-healed: the next unmount cleared the
 * store. Under this one it would not, and the consequence is worse than a stale bubble —
 * `deriveStreamingRegistrations` derives the editing-store streaming registration from the
 * store, and that registration suppresses SWR revalidation AND auth-token refresh APP-WIDE.
 * A stranded entry would therefore freeze data refresh across the entire application, for
 * the rest of the session, over one lost socket event.
 *
 * So entries expire on their own `startedAt`, swept on an interval. `STREAM_MAX_LIFETIME_MS`
 * is deliberately the SAME horizon the server's channel registry, abort registry and
 * heartbeat cap use — see `stream-horizons.ts` for why those three sharing one number
 * matters. An entry older than the longest a generation can possibly still be running is not
 * a live stream by any definition the server would recognise, so dropping it cannot race a
 * real one.
 *
 * ── ONE MORE THING THE SWEEP IS NOT ───────────────────────────────────────────────────────
 *
 * It is a leak backstop, not a completion path. It does not fire `onStreamComplete`, because
 * it does not know whether the stream completed — that is the point, it is here precisely
 * because nobody told us. Consumers reload from the DB on their own schedule; the sweep's
 * only job is to stop a lost event from being permanent.
 */

import type { UIMessage } from 'ai';
import { consumeStreamJoin, StreamJoinError } from '@/lib/ai/core/stream-join-client';
import { startStreamJoinPollFallback } from '@/lib/ai/core/stream-join-poll-fallback';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { STREAM_MAX_LIFETIME_MS } from '@/lib/ai/core/stream-horizons';

type UIMessagePart = UIMessage['parts'][number];

/**
 * Everything needed to render a bubble and arm a Stop BEFORE any frame has been read.
 *
 * `messageId` is stated by whoever opens the session — an admission envelope, a
 * `chat:stream_start` payload, or an `/active-streams` row — and NEVER inferred from frame
 * content. See `detached-stream-mode.ts` for why inferring it renders two assistant bubbles.
 */
export interface StreamSessionDescriptor {
  messageId: string;
  conversationId: string;
  /** The socket room / store partition key (`pageId` in the store's vocabulary). */
  channelId: string;
  triggeredBy: { userId: string; displayName: string };
  /** True when this generation belongs to the signed-in USER — see `isOwnStream`. */
  isOwn: boolean;
  /** ISO start time. Drives the synthesized bubble's `createdAt` and the expiry sweep. */
  startedAt: string;
  /**
   * A persisted snapshot to render immediately so a rejoining client is not blank.
   *
   * Replaced wholesale by the first folded write off the channel — there is nothing to
   * reconcile, because both are the same reduction of the same frames.
   */
  seedParts?: UIMessagePart[];
  /**
   * Where to start reading. 0 replays everything the server still holds.
   *
   * Any value above 0 makes this a MID-SEQ join, which is exactly the case where the SDK's
   * `start` frame is behind the cursor — hence `messageId` above being stated rather than
   * discovered.
   */
  fromSeq?: number;
}

/** How a session ended, for the caller that wants to reload or badge accordingly. */
export interface StreamSessionEnd {
  messageId: string;
  conversationId: string;
  /**
   * The channel it was on.
   *
   * Carried on the END rather than looked up, because by the time a listener runs the session
   * is already gone — and a per-channel listener that could not tell whether an end was its
   * own would have to either forward everything (waking surfaces for other channels) or
   * forward nothing.
   */
  channelId: string;
  /**
   * Whether the generation was STOPPED, when the server said so.
   *
   * `undefined` on the two client-local ends (a plain join resolve, the poll fallback noticing
   * the row vanished) — neither has a server-told answer to that question, and guessing
   * 'complete' would badge a genuinely interrupted reply as finished. Consumers that
   * replace-in-place should pass `aborted ? 'interrupted' : 'complete'`.
   */
  aborted?: boolean;
  /**
   * The join never delivered anything authoritative — usually because the stream lives on
   * another web instance whose in-process channel registry this one cannot reach. The
   * generation was fine; we just could not watch it. The consumer must reload the durably
   * persisted message rather than trust whatever partial content the store held.
   */
  joinFailed: boolean;
}

type SessionEndListener = (end: StreamSessionEnd) => void;

interface Session {
  descriptor: StreamSessionDescriptor;
  /** Aborts the SSE join. */
  controller: AbortController;
  /** Aborts the cross-instance poll fallback, when one is running. */
  pollController: AbortController | null;
  /**
   * Monotonic write counter for the POLL fallback's writes.
   *
   * Kept on the session rather than inside the poll closure: a fallback that restarts for the
   * same messageId must CONTINUE the count, not reset it. `applySetStreamParts` drops any
   * write whose seq is not strictly greater than the stored one, so a restarted counter's
   * early writes would be silently swallowed against the previous instance's watermark and
   * the bubble would freeze on stale content until the count caught back up.
   */
  pollSeq: number;
  /** The join delivered at least one folded write — i.e. what we hold is authoritative. */
  delivered: boolean;
  /** How many independent announcements referenced this stream. Diagnostic; never gates teardown. */
  refs: number;
  /** Millis since epoch, parsed from `startedAt` once, for the expiry sweep. */
  startedAtMs: number;
}

const sessions = new Map<string, Session>();
const endListeners = new Set<SessionEndListener>();

/**
 * How often the expiry sweep runs.
 *
 * Generous on purpose. The thing it catches is a lost terminal event, which is rare and — by
 * the time the horizon has passed — already an hour stale, so checking more often buys
 * nothing and a timer that fires constantly in every tab costs something.
 */
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

const store = () => usePendingStreamsStore.getState();

const notifyEnd = (end: StreamSessionEnd): void => {
  for (const listener of [...endListeners]) {
    try {
      listener(end);
    } catch (error) {
      // One consumer throwing must never strand the others, or the session's own teardown.
      console.error('[streamSessionRegistry] end listener threw', error);
    }
  }
};

/**
 * Subscribe to session endings. Returns an unsubscribe.
 *
 * Listeners are APP-WIDE and outlive any one surface, which is deliberate: the surface that
 * started a stream is frequently not the one on screen when it finishes, and a reload-from-DB
 * that only ran when the originating pane happened to still be mounted is the same
 * mount-scoped mistake this module exists to undo.
 */
export const onStreamSessionEnd = (listener: SessionEndListener): (() => void) => {
  endListeners.add(listener);
  return () => {
    endListeners.delete(listener);
  };
};

/**
 * Drop a session and its store entry, without claiming anything about why.
 *
 * `dropStoreEntry: false` keeps whatever content is on screen — used when a join fails but a
 * persisted snapshot is already rendered and is the only surviving copy of the partial reply.
 */
const teardown = (
  messageId: string,
  { dropStoreEntry }: { dropStoreEntry: boolean },
): Session | undefined => {
  const session = sessions.get(messageId);
  if (!session) return undefined;
  sessions.delete(messageId);
  session.controller.abort();
  session.pollController?.abort();
  if (dropStoreEntry) store().removeStream(messageId);
  return session;
};

/**
 * End a session and tell everyone — IN THAT ORDER, and the order is the whole point.
 *
 * The store entry is dropped AFTER the listeners have run, never before. Every consumer's
 * completion path reads the entry it is being told about: `conversationCacheSocketHandlers`
 * calls `getActiveStreamById(messageId)` and commits `synthesizeAssistantMessage(...)` from
 * its parts, which is what makes the streaming → confirmed transition atomic in
 * `selectRenderedMessages`. Drop the entry first and that lookup misses, every completion
 * falls through to the reload-from-DB branch, and the user watches the finished reply blink
 * out and come back with a loading flip — on every single turn.
 *
 * The hook this replaces got this right by accident of structure (`fireComplete` inside the
 * `try`, `removeStream` in the `finally`). It is explicit here because it is not obvious, and
 * because getting it wrong is silent: nothing fails, the reply just flickers.
 *
 * `notifyEnd` is called even when the session is already gone — see `completeStreamSession`.
 */
const endSession = (messageId: string, end: Omit<StreamSessionEnd, 'messageId'>): void => {
  teardown(messageId, { dropStoreEntry: false });
  notifyEnd({ messageId, ...end });
  store().removeStream(messageId);
};

const ensureSweep = (): void => {
  if (sweepTimer !== null) return;
  if (typeof setInterval !== 'function') return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - STREAM_MAX_LIFETIME_MS;
    for (const [messageId, session] of [...sessions.entries()]) {
      if (session.startedAtMs > cutoff) continue;
      // Older than the longest a generation can still be running by the server's own
      // reckoning. Whatever this is, it is not a live stream — and leaving it would suppress
      // SWR and token refresh app-wide forever. Dropped WITHOUT firing the end listeners:
      // this is not a completion, we simply never learned what happened.
      teardown(messageId, { dropStoreEntry: true });
      console.warn('[streamSessionRegistry] expired a stream session that never reported an end', {
        messageId,
        startedAt: session.descriptor.startedAt,
      });
    }
    if (sessions.size === 0 && sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, EXPIRY_SWEEP_INTERVAL_MS);
  // Never hold a test runner (or a Node render) open for a sweep.
  (sweepTimer as unknown as { unref?: () => void }).unref?.();
};

/**
 * Fall back to the DB checkpoint when the live channel cannot serve this client.
 *
 * TWO WAYS TO GET HERE, and from the client's side they are the same situation:
 *
 *   - the join 404s — the common, benign cross-instance case;
 *   - the join resolves carrying `resumeFromSeq` — the cursor names a frame the server's
 *     memory ring has evicted.
 *
 * NEITHER IS A COMPLETION, and this is the single most important thing in this module to get
 * right. Reporting `resumeFromSeq` as a finished stream is a bug that already shipped once:
 * it fired the completion path, dropped the store entry, and the user watched the reply
 * vanish while the server was still generating. Workstream B may change where those frames
 * come from (Postgres rather than memory) — this handles the field the same way either way.
 *
 * `canPoll` is false where polling cannot help: a 403 or a 500 is not a liveness gap, and
 * polling through one would re-request a denial every second for the length of the
 * generation. Returns whether polling actually started, which is what tells the caller
 * whether there is anything left on screen worth preserving.
 */
const fallBackToDatabase = (
  session: Session,
  { canPoll }: { canPoll: boolean },
): boolean => {
  const { messageId, channelId, conversationId } = session.descriptor;
  if (!canPoll || session.controller.signal.aborted) return false;

  // A stale fallback for this messageId must not be orphaned — an overwritten handle would
  // leak its interval for the life of the tab.
  session.pollController?.abort();
  const pollController = new AbortController();
  session.pollController = pollController;

  startStreamJoinPollFallback(
    channelId,
    messageId,
    pollController.signal,
    (parts) => {
      session.pollSeq += 1;
      store().setStreamParts(messageId, parts, session.pollSeq);
    },
    () => {
      // The row is gone from `/active-streams`: the stream finished, or this 404 was never a
      // liveness gap to begin with. Either way there is nothing left to poll for.
      //
      // This MUST fire the same reload-from-DB signal `chat:stream_complete` does, not merely
      // drop the entry. That broadcast is best-effort, so when it never arrives this poll
      // noticing the row disappear is the ONLY remaining signal — and without an end
      // notification the synthesized bubble would vanish with nothing replacing it, which is
      // strictly worse than the frozen-but-visible snapshot that preceded the fallback.
      endSession(messageId, { conversationId, channelId, joinFailed: true });
    },
  );
  return true;
};

/**
 * Announce a live generation. Idempotent per messageId.
 *
 * Safe to call from every announcer that might learn about a stream — the send's own
 * admission envelope, a `chat:stream_start`, an `/active-streams` bootstrap row. Whoever
 * arrives first opens the join; the rest bump the refcount and return.
 */
export const openStreamSession = (descriptor: StreamSessionDescriptor): void => {
  const existing = sessions.get(descriptor.messageId);
  if (existing) {
    existing.refs += 1;
    return;
  }

  const startedAtMs = Date.parse(descriptor.startedAt);
  const session: Session = {
    descriptor,
    controller: new AbortController(),
    pollController: null,
    pollSeq: 0,
    delivered: false,
    refs: 1,
    // An unparseable timestamp must not make an entry IMMORTAL (NaN fails every comparison,
    // so `startedAtMs > cutoff` would be false — which happens to expire it immediately,
    // the safe direction, but by accident rather than by decision). Say so deliberately:
    // treat an unusable start time as "starting now", so the entry gets a full horizon and
    // is still swept eventually.
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
  };
  sessions.set(descriptor.messageId, session);
  ensureSweep();

  // Seed the store BEFORE the join opens, so the bubble (and the editing-store registration
  // derived from it) exists for the whole TTFB window rather than appearing with the first
  // frame. `addStream` is a no-op on an existing entry, so a co-mounted announcer cannot
  // double-seed.
  store().addStream({
    messageId: descriptor.messageId,
    pageId: descriptor.channelId,
    conversationId: descriptor.conversationId,
    triggeredBy: descriptor.triggeredBy,
    isOwn: descriptor.isOwn,
    startedAt: descriptor.startedAt,
    parts: descriptor.seedParts ?? [],
  });

  const hadSeed = (descriptor.seedParts?.length ?? 0) > 0;

  consumeStreamJoin(
    descriptor.messageId,
    session.controller.signal,
    (parts, seq) => {
      session.delivered = true;
      store().setStreamParts(descriptor.messageId, parts, seq + 1);
    },
    descriptor.fromSeq ?? 0,
  )
    .then((result) => {
      if (!sessions.has(descriptor.messageId)) return;

      if (result.resumeFromSeq !== undefined) {
        // RESEED FROM THIS SEQ — never a completion. See `fallBackToDatabase`. Deliberately
        // NOT re-joining from `resumeFromSeq` directly: the frames before it are gone, and a
        // fold starting mid-stream renders a reply missing its beginning — the
        // "plausible-looking gap" the channel's own invariant refuses to produce. The DB
        // checkpoint is the complete view; the live channel is not.
        if (!fallBackToDatabase(session, { canPoll: true }) && !hadSeed) {
          teardown(descriptor.messageId, { dropStoreEntry: true });
        }
        return;
      }

      endSession(descriptor.messageId, {
        conversationId: descriptor.conversationId,
        channelId: descriptor.channelId,
        joinFailed: false,
      });
    })
    .catch((error: unknown) => {
      if (!sessions.has(descriptor.messageId)) return;

      const polling = fallBackToDatabase(session, {
        canPoll: error instanceof StreamJoinError && error.status === 404,
      });
      if (!polling && !hadSeed && !session.delivered) {
        // Nothing seeded, nothing delivered, and nothing left to poll — there is no content
        // to preserve. A seeded snapshot, by contrast, is usually the only surviving copy of
        // the partial reply (the originator's process died, so its channel 404s), and
        // removing it here would undo the restore that just happened.
        endSession(descriptor.messageId, {
          conversationId: descriptor.conversationId,
          channelId: descriptor.channelId,
          joinFailed: true,
        });
        return;
      }
      if (!session.controller.signal.aborted) {
        console.error('[streamSessionRegistry] stream join error', error);
      }
    });
};

/**
 * The server said this generation is over.
 *
 * Called from the `chat:stream_complete` handler. The store entry is dropped either way; what
 * `joinFailed` decides is whether consumers must reload the persisted message (because what
 * we hold is a stale snapshot at best) or may keep what is on screen.
 *
 * `!delivered` is folded into `joinFailed` for a race the flag alone cannot cover: a join
 * commonly 404s BECAUSE the stream just ended, and the completion event can land before that
 * rejection settles. In that window the store still holds only the seeded snapshot — which is
 * debounced, and can be SHORTER than the full reply. A join that delivered nothing is not
 * authoritative whatever its error handler has managed to record yet.
 */
export const completeStreamSession = ({
  messageId,
  conversationId,
  channelId,
  aborted,
}: {
  messageId: string;
  /**
   * Optional because `chat:stream_complete` carries it optionally — during a rolling deploy an
   * originator on the previous build emits the event without it. The SESSION's own id is
   * preferred whenever we have one: it came from the descriptor that opened the join, so it is
   * the authoritative answer and cannot be missing.
   */
  conversationId?: string;
  channelId: string;
  aborted?: boolean;
}): void => {
  const session = sessions.get(messageId);
  // No session means nothing here was watching this stream — a completion for a channel this
  // tab never opened, or one already reconciled. Still forwarded, because a surface may hold
  // a cache row for it that needs replacing; `joinFailed` is true because we certainly hold
  // no authoritative copy of a stream we never read.
  const resolvedConversationId = session?.descriptor.conversationId ?? conversationId;
  if (resolvedConversationId === undefined) {
    // An old-build completion for a stream this tab never watched. There is no conversation to
    // name, so a consumer could not act on it anyway — and inventing an empty id would send
    // every conversation-keyed listener looking for a row under `''`.
    return;
  }
  endSession(messageId, {
    conversationId: resolvedConversationId,
    channelId,
    aborted,
    joinFailed: session ? !session.delivered : true,
  });
};

/**
 * Tear down every session on a channel without reporting completions.
 *
 * For access revocation: the user can no longer reach these streams, so their entries must go
 * — but nothing completed, and telling consumers otherwise would have them reload messages
 * they are no longer permitted to read.
 */
export const closeChannelSessions = (channelId: string): void => {
  for (const [messageId, session] of [...sessions.entries()]) {
    if (session.descriptor.channelId !== channelId) continue;
    teardown(messageId, { dropStoreEntry: true });
  }
  store().clearPageStreams(channelId);
};

/**
 * Reconcile against the server's list of what is still live on a channel.
 *
 * A session whose stream the server no longer reports as running lost its terminal event —
 * the same class the expiry sweep catches, but caught in seconds rather than at the horizon,
 * because bootstrap actually asked. Dropped WITH an end notification (unlike the sweep):
 * bootstrap is an authoritative answer, so consumers should reload the persisted message.
 */
export const reconcileChannelSessions = (
  channelId: string,
  liveMessageIds: ReadonlySet<string>,
): void => {
  for (const [messageId, session] of [...sessions.entries()]) {
    if (session.descriptor.channelId !== channelId) continue;
    if (liveMessageIds.has(messageId)) continue;
    endSession(messageId, {
      conversationId: session.descriptor.conversationId,
      channelId,
      joinFailed: !session.delivered,
    });
  }
};

/** Test-only. Module state otherwise leaks across cases. */
export const resetStreamSessionRegistry = (): void => {
  for (const messageId of [...sessions.keys()]) teardown(messageId, { dropStoreEntry: true });
  endListeners.clear();
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
};
