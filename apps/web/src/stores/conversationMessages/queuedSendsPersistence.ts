import type { UIMessage } from 'ai';
import { MAX_QUEUED_SENDS } from '@/stores/conversationMessages/applyQueuedSends';

/**
 * localStorage persistence for the send queue, keyed by conversationId
 * (issue #2676).
 *
 * WHY the queue, alone among the conversation cache, persists at all: the
 * queue is the only client-held state whose loss silently BREAKS a promise.
 * An optimistic bubble lost to a reload was merely cosmetic (the server has
 * the row the moment the POST landed); a queued message lost to a reload was
 * never sent at all — the user watched it vanish. Restoring it on mount, with
 * the id it was minted with, keeps the promise: the drain dispatches it after
 * the (server-owned, reload-surviving) stream ends, and the stable id makes a
 * re-dispatch idempotent against the server's upsert-by-id.
 *
 * Every write goes through the store actions' facade, so persistence can
 * never disagree with the in-memory queue: an empty list REMOVES the key
 * rather than storing `[]`, so a drained queue does not leave litter behind.
 *
 * All I/O is guarded: `typeof window` for SSR (the store module is evaluated
 * wherever its types are imported), and try/catch for private-browsing quota
 * errors, where the queue simply stays session-scoped rather than crashing a
 * send.
 */
const keyFor = (conversationId: string): string => `pagespace:queued-sends:${conversationId}`;

/** Write the conversation's queue (an empty list removes the key). Best-effort. */
export const persistQueuedSends = (conversationId: string, messages: UIMessage[]): void => {
  if (typeof window === 'undefined') return;
  try {
    if (messages.length === 0) {
      window.localStorage.removeItem(keyFor(conversationId));
      return;
    }
    window.localStorage.setItem(
      keyFor(conversationId),
      JSON.stringify(messages.slice(0, MAX_QUEUED_SENDS)),
    );
  } catch {
    // Quota / privacy-mode failure: the in-memory queue keeps working.
  }
};

/**
 * A queued message is a user message with a string id and a parts array —
 * the shape `buildUserMessage` mints and the drain dispatches. Anything else
 * in storage is corruption (another app's key collision, a schema change) and
 * is dropped entry-wise rather than poisoning the whole restore.
 */
const isPersistedQueuedSend = (value: unknown): value is UIMessage => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; role?: unknown; parts?: unknown };
  return (
    typeof candidate.id === 'string' &&
    candidate.role === 'user' &&
    Array.isArray(candidate.parts)
  );
};

/**
 * Read the conversation's persisted queue, preserving the original ids and
 * order. Returns [] for a missing, corrupt, or over-cap-truncated payload —
 * never throws.
 */
export const readPersistedQueuedSends = (conversationId: string): UIMessage[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(keyFor(conversationId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPersistedQueuedSend).slice(0, MAX_QUEUED_SENDS);
  } catch {
    return [];
  }
};
