import { create } from 'zustand';
import { UIMessage } from 'ai';
import { createId } from '@paralleldrive/cuid2';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import {
  createAgentConversation,
  fetchAgentConversationMessages,
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
  /**
   * True while messages are being fetched for an ALREADY-known conversation
   * (loadConversation), decoupled from identity resolution — loadConversation
   * adopts its id synchronously (closing the create/select race), so
   * isConversationLoading alone no longer covers this fetch window. Without
   * this, a conversation switch could flash the previous conversation's
   * messages under the new conversation's identity/header with no loading
   * indicator.
   */
  isConversationMessagesLoading: boolean;
  conversationMessages: UIMessage[];
  conversationAgentId: string | null; // Track which agent the conversation belongs to
  /** Increments every time conversation state is set by loadConversation,
   *  createNewConversation, or loadMostRecentConversation.
   *  GlobalAssistantView watches this to re-apply messages via setAgentMessages
   *  even when the conversation ID doesn't change (clicking the same conversation). */
  conversationLoadSignal: number;

  // Streaming state (for agent mode sync between GlobalAssistantView and sidebar)
  isAgentStreaming: boolean;
  agentStopStreaming: (() => void) | null;

  // Sidebar tab state (for dashboard context only - GlobalAssistantView <-> RightPanel sync)
  activeTab: SidebarTab;

  // Methods
  selectAgent: (agent: AgentInfo | null) => void;
  initializeFromUrlOrCookie: () => Promise<void>;
  setActiveTab: (tab: SidebarTab) => void;

  // Conversation methods
  loadConversation: (conversationId: string) => Promise<void>;
  createNewConversation: () => Promise<string | null>;
  setConversationMessages: (messages: UIMessage[]) => void;
  clearConversation: () => void;
  loadMostRecentConversation: () => Promise<void>;

  // Streaming methods
  setAgentStreaming: (isStreaming: boolean) => void;
  setAgentStopStreaming: (stop: (() => void) | null) => void;
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
  conversationMessages: [],
  isConversationLoading: false,
  isConversationMessagesLoading: false,
  conversationAgentId: null,
  conversationLoadSignal: 0,
  isAgentStreaming: false,
  agentStopStreaming: null,
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
        conversationMessages: [],
        conversationAgentId: null,
        isConversationMessagesLoading: false,
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
   */
  loadConversation: async (conversationId: string) => {
    const agent = get().selectedAgent;
    if (!agent) return;

    applyIdentity({ type: 'IDENTITY_SET', conversationId });
    set({ conversationAgentId: agent.id, isConversationMessagesLoading: true });
    setChatParams({ agentId: agent.id, conversationId }, 'push');

    try {
      const result = await fetchAgentConversationMessages(agent.id, conversationId, { limit: 50 });
      // Drop a stale result if the user switched to a different conversation
      // while this fetch was in flight.
      if (conversationIdFrom(get().identity) !== conversationId) return;
      set({
        conversationMessages: result.messages,
        conversationLoadSignal: get().conversationLoadSignal + 1,
        isConversationMessagesLoading: false,
      });
    } catch (error) {
      console.error('Failed to load conversation:', error);
      toast.error('Failed to load conversation');
      set({ isConversationMessagesLoading: false });
    }
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
    set({
      conversationMessages: [],
      conversationAgentId: agent.id,
      conversationLoadSignal: get().conversationLoadSignal + 1,
      isConversationMessagesLoading: false,
    });

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
   * Update conversation messages (for optimistic UI updates)
   */
  setConversationMessages: (messages: UIMessage[]) => {
    set({ conversationMessages: messages });
  },

  /**
   * Clear conversation state
   */
  clearConversation: () => {
    set({
      identity: IDLE_IDENTITY,
      conversationId: null,
      conversationMessages: [],
      conversationAgentId: null,
      isConversationMessagesLoading: false,
    });
  },

  /**
   * Load the most recent conversation for the current agent. This is the one
   * genuinely async unknown ("which conversation does this agent already
   * have") — routed through RESOLVE_STARTED/RESOLVED/RESOLVE_FAILED so a
   * stale result here can never clobber an identity the user has since set
   * more recently via loadConversation/createNewConversation.
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
        const result = await fetchAgentConversationMessages(agent.id, conversationIdFromUrl, { limit: 50 });
        const resolved = applyIdentity({ type: 'RESOLVED', conversationId: conversationIdFromUrl });
        // A newer identity (set via loadConversation/createNewConversation
        // while this was in flight) wins — don't apply these stale messages.
        if (conversationIdFrom(resolved) !== conversationIdFromUrl) return;
        set({
          conversationMessages: result.messages,
          conversationAgentId: agent.id,
          conversationLoadSignal: get().conversationLoadSignal + 1,
        });
        return;
      }

      // Try to load most recent conversation
      const mostRecent = await fetchMostRecentAgentConversation(agent.id);
      if (mostRecent) {
        const result = await fetchAgentConversationMessages(agent.id, mostRecent.id, { limit: 50 });
        const resolved = applyIdentity({ type: 'RESOLVED', conversationId: mostRecent.id });
        if (conversationIdFrom(resolved) !== mostRecent.id) return;
        set({
          conversationMessages: result.messages,
          conversationAgentId: agent.id,
          conversationLoadSignal: get().conversationLoadSignal + 1,
        });

        // Update URL (use 'replace' for auto-loading to avoid polluting history)
        setChatParams({ agentId: agent.id, conversationId: mostRecent.id }, 'replace');
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

  /**
   * Set agent streaming state (for sync between GlobalAssistantView and sidebar)
   */
  setAgentStreaming: (isStreaming: boolean) => {
    set({ isAgentStreaming: isStreaming });
  },

  /**
   * Set agent stop streaming function (for sync between GlobalAssistantView and sidebar)
   */
  setAgentStopStreaming: (stop: (() => void) | null) => {
    set({ agentStopStreaming: stop });
  },
  };
});
