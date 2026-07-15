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
