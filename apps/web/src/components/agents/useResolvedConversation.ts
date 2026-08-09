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
 *
 * `authLoading` gates the FIRST resolve: on a hard refresh `useAuth` starts
 * out loading, so `canUseSessions` reads as false before the role is known.
 * Resolving anyway would mint a fresh agent's first conversation as a PLAIN
 * one — and thread→session binding is congenital and permanent, so that
 * conversation could never gain a grid afterward. Waiting costs nothing: the
 * caller is already rendering its own loading state for an unresolved auth.
 */
import { useEffect, useRef, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { fetchMostRecentAgentConversation, createAgentConversation } from '@/lib/ai/shared/agent-conversations';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { post, ApiRequestError } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { classifySpawnRefusal } from './spawn-refusal';

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
  sessionId,
}: {
  agentId: string;
  driveId: string;
  canUseSessions: boolean;
  /**
   * Mint the replacement INTO this session rather than spawning a new one —
   * set when the conversation being replaced was itself session-bound
   * (deleting the current conversation must never abandon its session).
   * Takes priority over `canUseSessions`: reuse is never downgraded to a
   * fresh spawn.
   */
  sessionId?: string | null;
}): Promise<ResolvedConversation> {
  if (sessionId) {
    const conversationId = createId();
    conversationMessagesActions.seedConversation(conversationId);
    await post(`/api/ai/page-agents/${encodeURIComponent(agentId)}/conversations`, { conversationId, sessionId });
    return { conversationId, sessionId };
  }

  if (canUseSessions) {
    try {
      const created = await post<{ session: { workspaceId: string }; conversationId: string }>(
        '/api/agent-workspaces',
        { driveId, agentPageId: agentId },
      );
      conversationMessagesActions.seedConversation(created.conversationId);
      return { conversationId: created.conversationId, sessionId: created.session.workspaceId };
    } catch (error) {
      // The role gate is a cheap client-side approximation; the server's
      // access decision (drive membership + code-execution) is the truth.
      // A refusal means "no workspace for you", not "no conversation" — but
      // QUOTA is worth interrupting the user for (they have the capability
      // and simply ran out of allowance); every other refusal degrades
      // silently, the same as a role that hasn't loaded yet.
      const status = error instanceof ApiRequestError ? error.status : undefined;
      const refusal = classifySpawnRefusal(status, error instanceof Error ? error.message : null);
      console.warn('Session spawn refused; falling back to a plain conversation:', error);
      if (refusal.kind === 'quota') {
        toast.error('Workspace unavailable — plain chat', { description: refusal.message });
      }
    }
  }

  const conversationId = createId();
  conversationMessagesActions.seedConversation(conversationId);
  await createAgentConversation(agentId, conversationId);
  return { conversationId, sessionId: null };
}

export function useResolvedConversation(
  agentId: string,
  {
    driveId,
    canUseSessions,
    authLoading,
    initialConversationId,
    initialSessionId,
  }: {
    driveId: string;
    canUseSessions: boolean;
    authLoading: boolean;
    /**
     * A deep-linked conversation to open instead of the agent's most-recent
     * one — e.g. a row clicked in the Agents surface's past-conversations
     * list. Trusted as-is (same trust level `useAgentSurfaceStore` already
     * extends to the session/conversation ids it passes through): read once,
     * synchronously, before the async most-recent-fetch path even starts, so
     * the two can never race each other.
     */
    initialConversationId?: string;
    initialSessionId?: string | null;
  },
): UseResolvedConversationResult {
  const [resolved, setResolved] = useState<ResolvedConversation | null>(null);
  const resolvingAgentIdRef = useRef<string | null>(null);
  // Read at resolve time, not depended on: auth settling after mount must not
  // re-resolve a conversation the user is already typing into.
  const canUseSessionsRef = useRef(canUseSessions);
  canUseSessionsRef.current = canUseSessions;
  const driveIdRef = useRef(driveId);
  driveIdRef.current = driveId;
  // The agentId resolution has already been KICKED OFF for. `authLoading` is
  // in the effect's deps only so a still-loading mount can wait for it once —
  // not so every later loading blip (token refresh, forced reload) restarts
  // resolution and clobbers a conversation the user is already typing into.
  const startedForAgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    // `user` (and so `canUseSessions`) is undefined/false while auth is still
    // loading. Resolving now would mint a fresh agent's first conversation as
    // a PLAIN one — and thread→session binding is congenital and permanent,
    // so a hard refresh could never give it a grid afterward. Wait it out;
    // the ref above already guarantees the capability read at resolve time is
    // the settled one.
    if (authLoading) return;
    // Already started (or finished) for this exact agent — a later
    // authLoading flip is not a reason to redo it.
    if (startedForAgentIdRef.current === agentId) return;
    startedForAgentIdRef.current = agentId;

    resolvingAgentIdRef.current = agentId;
    setResolved(null);

    const resolve = async () => {
      // Synchronous, before any await: a deep-linked id is used directly —
      // this can never race the async most-recent-fetch path below, since
      // exactly one of the two branches runs, chosen at the top.
      if (initialConversationId) {
        setResolved({ conversationId: initialConversationId, sessionId: initialSessionId ?? null });
        return;
      }

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
    // `initialConversationId`/`initialSessionId` are read once, at the top of
    // `resolve()`, for whichever agentId resolution is starting — safe to
    // list here because `startedForAgentIdRef` already blocks a second run
    // for an agentId that has already started, so a later change to either
    // (while a DIFFERENT agentId hasn't resolved yet) can't retrigger.
  }, [agentId, authLoading, initialConversationId, initialSessionId]);

  return { resolved, isLoading: resolved === null };
}
