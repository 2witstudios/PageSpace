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

/**
 * Background snapshot heal (F6, PR #2098 review): re-fetch the conversation and
 * commit via `applyServerSnapshot` — no `startLoad`, so `loadStatus` never flips
 * to 'loading' (no input-disable flicker, no skeleton) and mutations recorded
 * while the fetch was in flight are replayed onto the snapshot.
 *
 * Used after a stream-complete commit: the committed pending-stream parts give
 * instant render continuity, but the socket broadcast can outrace the SSE
 * multicast's final frames, so the parts may be a truncated snapshot — this
 * reconciles the authoritative DB row shortly after. Best-effort: a failure
 * leaves the committed parts standing (warn, never a UI error).
 */
export const refreshConversationSnapshot = async (
  agentId: string | null,
  conversationId: string,
): Promise<void> => {
  // Token BEFORE the fetch: any generation movement while the fetch is in flight
  // (a loud load, a fresher snapshot committing) invalidates this commit (CR4).
  const token = conversationMessagesActions.beginServerSnapshot(conversationId);
  try {
    if (agentId) {
      const result = await fetchAgentConversationMessages(agentId, conversationId, {
        limit: 50,
        includeStreaming: true,
      });
      conversationMessagesActions.applyServerSnapshot(conversationId, token, result.messages);
      return;
    }
    const res = await fetchWithAuth(
      `/api/ai/global/${conversationId}/messages?limit=50&includeStreaming=1`,
    );
    if (!res.ok) {
      console.warn('[conversationMessagesLoaders] snapshot refresh failed', conversationId, res.status);
      return;
    }
    const data = await res.json();
    const messages: UIMessage[] = Array.isArray(data) ? data : (data.messages ?? []);
    conversationMessagesActions.applyServerSnapshot(conversationId, token, messages);
  } catch (error) {
    console.warn('[conversationMessagesLoaders] snapshot refresh failed', conversationId, error);
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
