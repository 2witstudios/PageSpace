import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { UIMessage } from 'ai';
import { fetchAgentConversationMessages } from '@/lib/ai/shared/agent-conversations';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

/**
 * The shared cache load path (PR 5B) — the ONE way a conversation's DB
 * messages reach `useConversationMessagesStore`. Every load/refresh trigger
 * (conversation select, socket reconnect, undo, pull-up refresh, app resume)
 * funnels through these two functions, so staleness is decided once, by the
 * store's `loadGeneration` gate, instead of per-surface requested-id refs.
 *
 * Both loaders carry `includeStreaming=1` UNIFORMLY (absorbed E2 D task): a
 * conversation opened from a streaming-badged history entry has an in-flight
 * 'streaming' placeholder row that a default fetch excludes. Including it is
 * what lets `selectRenderedMessages` recognize the collision with the live
 * pending-stream entry and render the live stream in place of the stale
 * placeholder. Harmless for the common non-streaming case: no such row exists.
 *
 * Failure marks the entry's `loadStatus` 'error' (surfaces render a retry
 * affordance from the cache) and never clears cached messages — plus a
 * console.warn, since a swallowed load failure is a silent degradation.
 */
export const loadGlobalConversationMessages = async (conversationId: string): Promise<void> => {
  const generation = conversationMessagesActions.startLoad(conversationId);
  try {
    const res = await fetchWithAuth(
      `/api/ai/global/${conversationId}/messages?limit=50&includeStreaming=1`,
    );
    if (!conversationMessagesActions.isLoadCurrent(conversationId, generation)) return;
    if (!res.ok) {
      console.warn('[conversationMessagesLoaders] global load failed', conversationId, res.status);
      conversationMessagesActions.failLoad(conversationId, generation);
      return;
    }
    const data = await res.json();
    if (!conversationMessagesActions.isLoadCurrent(conversationId, generation)) return;
    const messages: UIMessage[] = Array.isArray(data) ? data : (data.messages ?? []);
    conversationMessagesActions.applyLoad(conversationId, generation, messages);
  } catch (error) {
    console.warn('[conversationMessagesLoaders] global load failed', conversationId, error);
    // failLoad is generation-gated, so a stale failure cannot clobber a newer load's status.
    conversationMessagesActions.failLoad(conversationId, generation);
  }
};

export const loadAgentConversationMessages = async (
  agentId: string,
  conversationId: string,
): Promise<void> => {
  const generation = conversationMessagesActions.startLoad(conversationId);
  try {
    const result = await fetchAgentConversationMessages(agentId, conversationId, {
      limit: 50,
      includeStreaming: true,
    });
    if (!conversationMessagesActions.isLoadCurrent(conversationId, generation)) return;
    conversationMessagesActions.applyLoad(conversationId, generation, result.messages);
  } catch (error) {
    console.warn('[conversationMessagesLoaders] agent load failed', agentId, conversationId, error);
    conversationMessagesActions.failLoad(conversationId, generation);
  }
};
