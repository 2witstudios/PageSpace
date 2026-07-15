/**
 * Pure transitions for the history tab's "currently streaming" conversation-id set (leaf 5.2).
 * Seeded from GET /api/ai/chat/active-streams?scope=user (leaf 5.1) and kept fresh by the same
 * chat:stream_start/chat:stream_complete events every other stream surface already listens to.
 * No-ops return the SAME set reference so a React state setter can skip a re-render.
 */

export const parseStreamingConversationIds = (
  data: { streams?: { conversationId: string }[] } | null | undefined,
): Set<string> => new Set((data?.streams ?? []).map((s) => s.conversationId));

export const addStreamingConversation = (
  ids: ReadonlySet<string>,
  conversationId: string,
): Set<string> => {
  if (ids.has(conversationId)) return ids as Set<string>;
  const next = new Set(ids);
  next.add(conversationId);
  return next;
};

export const removeStreamingConversation = (
  ids: ReadonlySet<string>,
  conversationId: string,
): Set<string> => {
  if (!ids.has(conversationId)) return ids as Set<string>;
  const next = new Set(ids);
  next.delete(conversationId);
  return next;
};

/**
 * Review finding (race condition): the discovery fetch is a snapshot taken when DISPATCHED, but
 * resolves an arbitrary time later. A chat:stream_start/complete landing in that window is NEWER
 * information than the snapshot — applying the snapshot as a blind replace would silently drop
 * it. `deltas` records every add/remove that happened while the fetch was in flight (see the
 * caller's `pendingDeltasRef`); replaying them on top of the fetched snapshot means the newer
 * information always wins, regardless of which one this particular fetch's response reflects.
 */
export const applyPendingDeltas = (
  fetched: ReadonlySet<string>,
  deltas: ReadonlyMap<string, 'add' | 'remove'>,
): Set<string> => {
  if (deltas.size === 0) return fetched as Set<string>;
  const next = new Set(fetched);
  for (const [conversationId, action] of deltas) {
    if (action === 'add') next.add(conversationId);
    else next.delete(conversationId);
  }
  return next;
};
