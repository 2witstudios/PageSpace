import { browserLoggers } from '@pagespace/lib/logging/logger-browser';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { refreshConversationSnapshot } from '@/hooks/conversationMessagesLoaders';

/** Structured, like the rest of this layer — `console` bypasses log levels and redaction. */
const log = browserLoggers.realtime.child({ module: 'conversation-rev-sync' });

/**
 * The reconnect half of the delivery protocol (Agent-Session Single Source of
 * Truth epic, Phase 2; `docs/2.0-architecture/agent-sessions.md` §3 clause 3).
 *
 * Broadcast transport is best-effort by design — a socket that was gone for ten
 * seconds simply did not receive the events emitted in those ten seconds, and
 * nothing replays them. What makes that survivable is the watermark: on
 * reconnect, ONE batched `POST /api/ai/conversations/revs` asks the server what
 * rev every subscribed conversation is at, and only the ones that disagree with
 * their local watermark are refetched. A hundred open panes cost one request and
 * zero refetches when nothing changed while they were away.
 *
 * Module-level, not per-hook: batching is the entire point, so the registry of
 * "which conversations is this tab subscribed to" has to outlive any single
 * component. Every subscription registers on mount and unregisters on unmount,
 * refcounted so two panes on the same conversation don't unregister each other.
 */

interface ConversationWatch {
  /** The agent page hosting it, or `null` for a global-assistant conversation — picks the refetch endpoint. */
  agentPageId: string | null;
  /** How many mounted subscriptions are watching this conversation. */
  count: number;
}

const watches = new Map<string, ConversationWatch>();

/** Adds one watcher for `conversationId`. Idempotent per mount; pair with `unregisterConversationWatch`. */
export const registerConversationWatch = (conversationId: string, agentPageId: string | null): void => {
  const existing = watches.get(conversationId);
  if (existing) {
    existing.count += 1;
    // Last mount wins on the endpoint. The two only ever disagree if the same
    // conversation id is somehow opened as both page-anchored and global, which
    // the data model forbids — this just refuses to hold a stale answer.
    existing.agentPageId = agentPageId;
    return;
  }
  watches.set(conversationId, { agentPageId, count: 1 });
};

/** Removes one watcher; the conversation leaves the batch when the last one goes. */
export const unregisterConversationWatch = (conversationId: string): void => {
  const existing = watches.get(conversationId);
  if (!existing) return;
  existing.count -= 1;
  if (existing.count <= 0) watches.delete(conversationId);
};

/** Test seam: the ids currently in the reconnect batch. */
export const watchedConversationIds = (): string[] => [...watches.keys()];

/** Test seam — drops every watch. Never called in production. */
export const resetConversationWatches = (): void => {
  watches.clear();
  inFlightSync = null;
};

/**
 * Refetch `conversationId` until its watermark reaches `targetRev`, bounded to
 * two passes.
 *
 * The second pass exists because `refreshConversationSnapshot` COALESCES
 * concurrent refreshes for the same conversation: a burst of writes produces a
 * burst of gap-detections, and every one after the first rides an in-flight
 * fetch that may have been issued BEFORE the write it is supposed to heal to.
 * Settling for that snapshot would leave the cache permanently one write short,
 * healed only by whatever event happens to arrive next. One extra pass — issued
 * after the first settled, so the coalescing map is clear and it really is a
 * fresh read — closes it. Bounded rather than looping: an unreachable target
 * (the row was rolled back, the response is from an older instance) must cost
 * two requests, not an infinite retry storm.
 */
export const healConversationToRev = async (
  conversationId: string,
  agentPageId: string | null,
  targetRev: number | null,
): Promise<void> => {
  await refreshConversationSnapshot(agentPageId, conversationId);
  if (targetRev === null) return;
  const reached = conversationMessagesActions.getRev(conversationId);
  if (reached !== null && reached >= targetRev) return;
  await refreshConversationSnapshot(agentPageId, conversationId);
};

interface RevsResponse {
  revs?: Record<string, number>;
}

// One in-flight sync at a time. Every mounted subscription observes the same
// reconnect, and N identical batch requests would be N times the work for one
// answer — the second through Nth caller joins the first's promise.
let inFlightSync: Promise<void> | null = null;

/**
 * The reconnect check: one batched revs request for every watched conversation,
 * then a refetch of exactly the ones whose server rev disagrees with the local
 * watermark.
 *
 * A conversation with NO local watermark (`null` — its load never committed one,
 * or it was seeded rather than fetched) is refetched too: "unknown" cannot be
 * proven current, and this is the cheap moment to establish it.
 *
 * An id absent from the response is left alone. Absence means the row is gone or
 * the caller may no longer access it (the route filters through
 * `canAccessConversation`); either way blanking a cache the user can still see is
 * worse than leaving it, and the surfaces have their own access errors to render.
 *
 * Best-effort throughout — a failure logs and returns. The next event's gap
 * detection is a second chance at exactly the same heal.
 */
export const syncWatchedConversationRevs = (): Promise<void> => {
  if (inFlightSync) return inFlightSync;
  const run = doSyncWatchedConversationRevs().finally(() => {
    inFlightSync = null;
  });
  inFlightSync = run;
  return run;
};

const doSyncWatchedConversationRevs = async (): Promise<void> => {
  const entries = [...watches.entries()];
  if (entries.length === 0) return;
  try {
    const res = await fetchWithAuth('/api/ai/conversations/revs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: entries.map(([id]) => id) }),
    });
    if (!res.ok) {
      log.warn('revs check failed', { status: res.status });
      return;
    }
    const { revs } = (await res.json()) as RevsResponse;
    if (!revs) return;
    await Promise.all(
      entries.map(async ([conversationId, watch]) => {
        const serverRev = revs[conversationId];
        if (typeof serverRev !== 'number') return;
        const localRev = conversationMessagesActions.getRev(conversationId);
        if (localRev !== null && localRev >= serverRev) return;
        await healConversationToRev(conversationId, watch.agentPageId, serverRev);
      }),
    );
  } catch (error) {
    log.warn('revs check failed', { error: error instanceof Error ? error.message : 'unknown' });
  }
};
