import type { AgentConversation } from '../chat-model/chat';

/** Conversation ids with a reply still streaming, from active-streams?scope=user. */
export const streamingConversationIds = (body: unknown): ReadonlySet<string> => {
  if (typeof body !== 'object' || body === null) return new Set();
  const { streams } = body as { readonly streams?: unknown };
  if (!Array.isArray(streams)) return new Set();
  return new Set(
    streams.flatMap((stream: unknown) => {
      const id = typeof stream === 'object' && stream !== null ? (stream as { conversationId?: unknown }).conversationId : undefined;
      return typeof id === 'string' ? [id] : [];
    }),
  );
};

/**
 * "Search conversations…" filters what has loaded: the conversations route takes no query yet
 * (needs-api — conversation title search).
 */
export const matchingConversations = (
  conversations: readonly AgentConversation[],
  query: string,
): readonly AgentConversation[] => {
  const q = query.trim().toLowerCase();
  return q === '' ? conversations : conversations.filter((conversation) => conversation.title.toLowerCase().includes(q));
};
