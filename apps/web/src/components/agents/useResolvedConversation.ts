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
import { toast } from 'sonner';

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
        // Surfaced, not just logged: the conversation id is already seeded and
        // selected locally, so a silent failure here leaves the user typing into
        // a conversation the server has never heard of — their first send is the
        // first they'd learn of it. Matches the toast-on-failure convention the
        // rest of this surface uses (see useAgentSessionChat).
        console.error('Failed to create agent conversation:', error);
        toast.error('Could not start a new conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      }
    };
    void resolve();
  }, [agentId]);

  return { conversationId, isLoading: conversationId === null };
}
