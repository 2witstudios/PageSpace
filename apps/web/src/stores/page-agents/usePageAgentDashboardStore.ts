import { create } from 'zustand';
import { createId } from '@paralleldrive/cuid2';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import {
  createAgentConversation,
  fetchMostRecentAgentConversation,
  conversationIdentityReducer,
  conversationIdFrom,
  isResolving,
  type ConversationIdentityState,
} from '@/lib/ai/shared';
import { conversationState } from '@/lib/ai/core/conversation-state';
import { getAgentId, getConversationId, setChatParams } from '@/lib/url-state';
import { toast } from 'sonner';
import { AgentInfo } from '@/types/agent';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { loadAgentConversationMessages } from '@/hooks/conversationMessagesLoaders';

// Re-export AgentInfo for backward compatibility
export type { AgentInfo } from '@/types/agent';

/** Tab types for the right sidebar */
export type SidebarTab = 'chat' | 'history' | 'activity';

interface AgentState {
  // Selected agent (null = Global Assistant mode)
  selectedAgent: AgentInfo | null;

  // Initialization state
  isInitialized: boolean;

  /**
   * Single source of truth for conversation identity — every transition goes
   * through conversationIdentityReducer, so a stale loadMostRecentConversation
   * resolution can never clobber a newer createNewConversation/loadConversation
   * (the reducer ignores RESOLVED/RESOLVE_FAILED once state has moved past
   * 'resolving'). conversationId/isConversationLoading below are derived from
   * this on every transition and kept as plain fields (not getters) so
   * existing Zustand selectors don't need to change.
   */
  identity: ConversationIdentityState;
  conversationId: string | null;
  isConversationLoading: boolean;
  conversationAgentId: string | null; // Track which agent the conversation belongs to

  // Sidebar tab state (for dashboard context only - GlobalAssistantView <-> RightPanel sync)
  activeTab: SidebarTab;

  // Methods
  selectAgent: (agent: AgentInfo | null) => void;
  initializeFromUrlOrCookie: () => Promise<void>;
  setActiveTab: (tab: SidebarTab) => void;

  // Conversation methods
  loadConversation: (conversationId: string) => Promise<void>;
  createNewConversation: () => Promise<string | null>;
  clearConversation: () => void;
  loadMostRecentConversation: () => Promise<void>;
}

const IDLE_IDENTITY: ConversationIdentityState = { status: 'idle' };

export const usePageAgentDashboardStore = create<AgentState>()((set, get) => {
  // Every conversation-identity transition funnels through the shared pure
  // reducer, so a stale async result can never clobber a newer one — a
  // RESOLVED/RESOLVE_FAILED that arrives after IDENTITY_SET already moved
  // state to 'ready' is a guaranteed no-op (see conversation-identity.ts).
  const applyIdentity = (action: Parameters<typeof conversationIdentityReducer>[1]) => {
    const current = get().identity;
    const next = conversationIdentityReducer(current, action);
    // The reducer returns the same reference for a guaranteed no-op (e.g. a
    // stale RESOLVED/RESOLVE_FAILED after a newer IDENTITY_SET already won)
    // — skip the store write so subscribers aren't notified for nothing.
    if (next !== current) {
      set({
        identity: next,
        conversationId: conversationIdFrom(next),
        isConversationLoading: isResolving(next),
      });
    }
    return next;
  };

  return {
  selectedAgent: null,
  isInitialized: false,
  identity: IDLE_IDENTITY,
  conversationId: null,
  isConversationLoading: false,
  conversationAgentId: null,
  activeTab: 'history', // Default for dashboard (no chat tab in dashboard context)

  /**
   * Set the active sidebar tab (dashboard context only)
   * Used for GlobalAssistantView <-> RightPanel communication
   */
  setActiveTab: (tab: SidebarTab) => {
    set({ activeTab: tab });
  },

  /**
   * Select an agent (or null for Global Assistant)
   * This updates the UI state and persists to cookie
   */
  selectAgent: (agent: AgentInfo | null) => {
    const currentAgent = get().selectedAgent;
    const isSwitchingAgent = agent?.id !== currentAgent?.id;

    // Clear conversation state when switching agents — identity resets to
    // idle (a genuinely new subject, same as AiChatView remounting via key;
    // Zustand stores have no React key equivalent, so an explicit reset here
    // is the idiomatic move, not a workaround).
    if (isSwitchingAgent) {
      set({
        selectedAgent: agent,
        identity: IDLE_IDENTITY,
        conversationId: null,
        conversationAgentId: null,
      });
    } else {
      set({ selectedAgent: agent });
    }

    if (agent) {
      // Switching to agent mode - persist to cookie
      conversationState.setActiveAgentId(agent.id);

      // Update URL with agent param, clear old conversation ID
      setChatParams({ agentId: agent.id, conversationId: null }, 'push');

      // Automatically load most recent conversation for this agent
      if (isSwitchingAgent) {
        get().loadMostRecentConversation();
      }
    } else {
      // Switching back to Global Assistant - clear cookie
      conversationState.setActiveAgentId(null);

      // Clear agent and conversation from URL
      setChatParams({ agentId: null, conversationId: null }, 'push');
    }
  },

  /**
   * Initialize agent selection from URL or cookie
   * Called once on app mount
   */
  initializeFromUrlOrCookie: async () => {
    // Don't re-initialize if already done
    if (get().isInitialized) return;

    try {
      const urlParams = new URLSearchParams(window.location.search);
      const rawAgentId = urlParams.get('agent');
      const cookieAgentId = conversationState.getActiveAgentId();

      // Validate agentId format (CUID2: lowercase letter followed by lowercase alphanumeric, max 32 chars)
      const urlAgentId = rawAgentId && /^[a-z][a-z0-9]{1,31}$/.test(rawAgentId) ? rawAgentId : null;
      const agentId = urlAgentId || cookieAgentId;

      if (agentId) {
        // Fetch agent info to restore selection
        const agentsResponse = await fetchWithAuth('/api/ai/page-agents/multi-drive?groupByDrive=true');
        if (agentsResponse.ok) {
          const agentsData = await agentsResponse.json();
          const allAgents = agentsData.agentsByDrive?.flatMap((d: { agents: unknown[] }) => d.agents) || [];
          const agent = allAgents.find((a: { id: string }) => a.id === agentId);

          if (agent) {
            // Persist to cookie so agent survives navigation/reload
            conversationState.setActiveAgentId(agent.id);

            set({
              selectedAgent: {
                id: agent.id,
                title: agent.title || 'Unnamed Agent',
                driveId: agent.driveId,
                driveName: agent.driveName,
                systemPrompt: agent.systemPrompt,
                aiProvider: agent.aiProvider,
                aiModel: agent.aiModel,
                enabledTools: agent.enabledTools,
              },
              isInitialized: true,
            });
            return;
          } else {
            // Agent not found - clear stale cookie and notify user
            conversationState.setActiveAgentId(null);
            // Clear URL params as well
            setChatParams({ agentId: null, conversationId: null }, 'replace');
            toast.error('Agent no longer accessible. Switched to Global Assistant.');
          }
        }
      }

      // No agent selected
      set({ isInitialized: true });
    } catch (error) {
      console.error('Failed to initialize agent selection:', error);
      set({ isInitialized: true });
    }
  },

  /**
   * Load a specific conversation by ID. The id is already known (it came from
   * a history list), so identity adopts it synchronously — before the
   * messages fetch even starts — closing the race where a send fired right
   * after selecting a conversation could land under the previous one.
   *
   * Messages land in the shared conversation cache (PR 5B, leaf 5.3): the
   * loader's `loadGeneration` gate replaces the local stale-result check, and
   * the cache entry's `loadStatus` replaces isConversationMessagesLoading /
   * the failure toast — surfaces render loading/error from the cache.
   */
  loadConversation: async (conversationId: string) => {
    const agent = get().selectedAgent;
    if (!agent) return;

    applyIdentity({ type: 'IDENTITY_SET', conversationId });
    set({ conversationAgentId: agent.id });
    setChatParams({ agentId: agent.id, conversationId }, 'push');

    await loadAgentConversationMessages(agent.id, conversationId);
  },

  /**
   * Create a new conversation for the current agent. The id is generated
   * client-side (cuid2) and set synchronously — the create POST below is a
   * fire-and-forget, idempotent persist, not the mechanism used to learn the
   * id. This closes the race where a send fired before the old server-round-trip
   * resolved would carry a stale conversationId.
   */
  createNewConversation: async () => {
    const agent = get().selectedAgent;
    if (!agent) return null;

    const conversationId = createId();
    applyIdentity({ type: 'IDENTITY_SET', conversationId });
    set({ conversationAgentId: agent.id });
    // A just-minted id has no server rows — mark it loaded-empty in the cache
    // so nothing fetches for it and no loading state shows.
    conversationMessagesActions.seedConversation(conversationId);

    // Update URL for bookmarkability
    setChatParams({ agentId: agent.id, conversationId }, 'push');

    try {
      await createAgentConversation(agent.id, conversationId);
    } catch (error) {
      console.error('Failed to create new conversation:', error);
      toast.error('Failed to create new conversation');
    }

    return conversationId;
  },

  /**
   * Clear conversation state
   */
  clearConversation: () => {
    set({
      identity: IDLE_IDENTITY,
      conversationId: null,
      conversationAgentId: null,
    });
  },

  /**
   * Load the most recent conversation for the current agent. This is the one
   * genuinely async unknown ("which conversation does this agent already
   * have") — routed through RESOLVE_STARTED/RESOLVED/RESOLVE_FAILED so a
   * stale result here can never clobber an identity the user has since set
   * more recently via loadConversation/createNewConversation.
   *
   * Identity resolves BEFORE the messages load now (PR 5B): the load commits
   * to the conversation-keyed cache, so it cannot land under the wrong
   * conversation, and a messages fetch failure surfaces as the cache entry's
   * 'error' state (retry affordance) instead of silently minting a fresh
   * conversation over a real one.
   */
  loadMostRecentConversation: async () => {
    const agent = get().selectedAgent;
    if (!agent) return;

    // Check if we already have a conversation for this agent
    if (get().conversationAgentId === agent.id && get().conversationId) {
      return;
    }

    applyIdentity({ type: 'RESOLVE_STARTED' });

    try {
      // Check URL for existing conversation ID first
      const conversationIdFromUrl = getConversationId();
      const agentIdFromUrl = getAgentId();

      // If URL has conversation for THIS agent, load it
      if (conversationIdFromUrl && agentIdFromUrl === agent.id) {
        const resolved = applyIdentity({ type: 'RESOLVED', conversationId: conversationIdFromUrl });
        // A newer identity (set via loadConversation/createNewConversation
        // while this was in flight) wins — don't adopt or load for the stale id.
        if (conversationIdFrom(resolved) !== conversationIdFromUrl) return;
        set({ conversationAgentId: agent.id });
        await loadAgentConversationMessages(agent.id, conversationIdFromUrl);
        return;
      }

      // Try to load most recent conversation
      const mostRecent = await fetchMostRecentAgentConversation(agent.id);
      if (mostRecent) {
        const resolved = applyIdentity({ type: 'RESOLVED', conversationId: mostRecent.id });
        if (conversationIdFrom(resolved) !== mostRecent.id) return;
        set({ conversationAgentId: agent.id });

        // Update URL (use 'replace' for auto-loading to avoid polluting history)
        setChatParams({ agentId: agent.id, conversationId: mostRecent.id }, 'replace');
        await loadAgentConversationMessages(agent.id, mostRecent.id);
        return;
      }

      // No existing conversation - create a new one. But only if nothing
      // else has resolved identity while these fetches were in flight —
      // createNewConversation's IDENTITY_SET always wins, so calling it
      // unconditionally here would clobber a newer loadConversation/
      // createNewConversation the user already triggered.
      if (!isResolving(get().identity)) return;
      await get().createNewConversation();
    } catch (error) {
      console.error('Failed to load most recent conversation:', error);
      const resolved = applyIdentity({ type: 'RESOLVE_FAILED', message: error instanceof Error ? error.message : 'Failed to load conversation' });
      // RESOLVE_FAILED only takes effect if we were still 'resolving' — if a
      // newer identity already won, resolved.status won't be 'error' and we
      // must not fall back to creating yet another conversation on top of it.
      if (resolved.status !== 'error') return;
      // Try to create a new one
      await get().createNewConversation();
    }
  },

  };
});

// NO MESSAGE ARRAYS (PR 5B, leaf 5.3) — and no agentStreaming/agentStops slots (PR 5A, 5.5.7).
//
// `conversationMessages`/`conversationLoadSignal`/`isConversationMessagesLoading`/
// `setConversationMessages` are gone: every loader above commits to
// `useConversationMessagesStore` (the shared per-conversation cache), and surfaces render
// `selectRenderedMessages(cacheEntry, activeStreams)` via the useRenderedMessages facade.
// The load-signal existed so GlobalAssistantView could re-apply this store's array into
// useChat without watching the array itself; with rendering per-conversation and
// merge-at-render, there is no array to re-apply and no signal to watch.
//
// This store now keeps only what it is actually for: agent selection, conversation identity,
// and the active tab.
