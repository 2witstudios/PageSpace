'use client';

/**
 * Resolves the conversation an `AgentView` in PAGE context opens on first
 * mount: the agent's most recent conversation, or a fresh client-minted one
 * when it has none yet — the same resolution `useMachinePaneChat`'s agent
 * mode performs, extracted here because a page view has no dual-mode
 * selector to hang it off of.
 *
 * Only the INITIAL value: once resolved, the caller owns switching
 * conversations (history select, new, delete) as plain local state — this
 * hook never re-resolves for an agentId it has already settled.
 */
import { useEffect, useRef, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { fetchMostRecentAgentConversation, createAgentConversation } from '@/lib/ai/shared/agent-conversations';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

export interface UseResolvedConversationResult {
  /** null until resolution completes. */
  conversationId: string | null;
  isLoading: boolean;
}

export function useResolvedConversation(agentId: string): UseResolvedConversationResult {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const resolvingAgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    resolvingAgentIdRef.current = agentId;
    setConversationId(null);

    const resolve = async () => {
      try {
        const mostRecent = await fetchMostRecentAgentConversation(agentId);
        if (resolvingAgentIdRef.current !== agentId) return;
        if (mostRecent) {
          setConversationId(mostRecent.id);
          return;
        }
      } catch (error) {
        if (resolvingAgentIdRef.current !== agentId) return;
        console.error('Failed to load recent agent conversation:', error);
      }
      if (resolvingAgentIdRef.current !== agentId) return;

      const newConversationId = createId();
      conversationMessagesActions.seedConversation(newConversationId);
      setConversationId(newConversationId);
      try {
        await createAgentConversation(agentId, newConversationId);
      } catch (error) {
        if (resolvingAgentIdRef.current !== agentId) return;
        console.error('Failed to create agent conversation:', error);
      }
    };
    void resolve();
  }, [agentId]);

  return { conversationId, isLoading: conversationId === null };
}
