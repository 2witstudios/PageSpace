'use client';

/**
 * Resolves the conversation the agent PAGE opens on first mount: the agent's
 * most recent conversation, or a fresh one when it has none yet.
 *
 * Resolution now carries the conversation's SESSION too (`sessionId`), because
 * the page's Chat tab renders a session-bound conversation as a PANE GRID
 * (split-capable, one shared sandbox) and a plain conversation as the plain
 * chat. The split is capability-shaped:
 *
 * - `canUseSessions` (the same admin gate every session surface uses): a fresh
 *   conversation is born WITH a session via the spawn route — one act, session
 *   + first conversation — so splitting works from the first message. If the
 *   server refuses the spawn (membership/capability say no even though the
 *   role gate said maybe), fall back to a plain conversation: the page must
 *   never fail to open over a workspace it merely could not have.
 * - otherwise: a plain conversation, exactly the pre-session behaviour. A
 *   session owns a sandbox, and a user without the code-execution surface
 *   must still be able to chat.
 *
 * Only the INITIAL value: once resolved, the caller owns switching
 * conversations (history select, new, delete) as plain local state — this
 * hook never re-resolves for an agentId it has already settled.
 */
import { useEffect, useRef, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { fetchMostRecentAgentConversation, createAgentConversation } from '@/lib/ai/shared/agent-conversations';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { post } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

export interface ResolvedConversation {
  conversationId: string;
  /** The workspace the thread lives in — null for a plain page chat (no panes). */
  sessionId: string | null;
}

export interface UseResolvedConversationResult {
  /** null until resolution completes. */
  resolved: ResolvedConversation | null;
  isLoading: boolean;
}

/**
 * Create a fresh page conversation, session-first when allowed. Shared by the
 * initial resolution and the page's new/delete-replacement flows so every
 * creation path answers the same question the same way.
 */
export async function createPageConversation({
  agentId,
  driveId,
  canUseSessions,
}: {
  agentId: string;
  driveId: string;
  canUseSessions: boolean;
}): Promise<ResolvedConversation> {
  if (canUseSessions) {
    try {
      const created = await post<{ session: { sessionId: string }; conversationId: string }>(
        '/api/agent-sessions',
        { driveId, agentPageId: agentId },
      );
      conversationMessagesActions.seedConversation(created.conversationId);
      return { conversationId: created.conversationId, sessionId: created.session.sessionId };
    } catch (error) {
      // The role gate is a cheap client-side approximation; the server's
      // access decision (drive membership + code-execution) is the truth.
      // A refusal means "no workspace for you", not "no conversation".
      console.warn('Session spawn refused; falling back to a plain conversation:', error);
    }
  }

  const conversationId = createId();
  conversationMessagesActions.seedConversation(conversationId);
  await createAgentConversation(agentId, conversationId);
  return { conversationId, sessionId: null };
}

export function useResolvedConversation(
  agentId: string,
  { driveId, canUseSessions }: { driveId: string; canUseSessions: boolean },
): UseResolvedConversationResult {
  const [resolved, setResolved] = useState<ResolvedConversation | null>(null);
  const resolvingAgentIdRef = useRef<string | null>(null);
  // Read at resolve time, not depended on: auth settling after mount must not
  // re-resolve a conversation the user is already typing into.
  const canUseSessionsRef = useRef(canUseSessions);
  canUseSessionsRef.current = canUseSessions;
  const driveIdRef = useRef(driveId);
  driveIdRef.current = driveId;

  useEffect(() => {
    resolvingAgentIdRef.current = agentId;
    setResolved(null);

    const resolve = async () => {
      try {
        const mostRecent = await fetchMostRecentAgentConversation(agentId);
        if (resolvingAgentIdRef.current !== agentId) return;
        if (mostRecent) {
          setResolved({ conversationId: mostRecent.id, sessionId: mostRecent.sessionId ?? null });
          return;
        }
      } catch (error) {
        if (resolvingAgentIdRef.current !== agentId) return;
        console.error('Failed to load recent agent conversation:', error);
      }
      if (resolvingAgentIdRef.current !== agentId) return;

      try {
        const created = await createPageConversation({
          agentId,
          driveId: driveIdRef.current,
          canUseSessions: canUseSessionsRef.current,
        });
        if (resolvingAgentIdRef.current !== agentId) return;
        setResolved(created);
      } catch (error) {
        if (resolvingAgentIdRef.current !== agentId) return;
        // The plain-create fallback failed too. Seed and select the id anyway
        // (the pre-session behaviour) and SAY so — a silent failure here
        // leaves the user typing into a conversation the server has never
        // heard of, and their first send is the first they'd learn of it.
        const conversationId = createId();
        conversationMessagesActions.seedConversation(conversationId);
        setResolved({ conversationId, sessionId: null });
        console.error('Failed to create agent conversation:', error);
        toast.error('Could not start a new conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
      }
    };
    void resolve();
  }, [agentId]);

  return { resolved, isLoading: resolved === null };
}
