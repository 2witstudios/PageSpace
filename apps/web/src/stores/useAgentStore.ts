import { create } from 'zustand';
import { UIMessage } from 'ai';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { conversationState } from '@/lib/ai/core/conversation-state';
import { toast } from 'sonner';
import { AgentInfo } from '@/types/agent';

// Re-export AgentInfo for backward compatibility
export type { AgentInfo } from '@/types/agent';

/** Tab types for the right sidebar */
export type SidebarTab = 'chat' | 'history' | 'settings';

interface AgentState {
  // Selected agent (null = Global Assistant mode)
  selectedAgent: AgentInfo | null;

  // Initialization state
  isInitialized: boolean;

  // Conversation management (for agent mode - centralized for sidebar + GlobalAssistantView)
  conversationId: string | null;
  conversationMessages: UIMessage[];
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
  setConversationMessages: (messages: UIMessage[]) => void;
  clearConversation: () => void;
  loadMostRecentConversation: () => Promise<void>;
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  selectedAgent: null,
  isInitialized: false,
  conversationId: null,
  conversationMessages: [],
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

    // Clear conversation state when switching agents
    if (isSwitchingAgent) {
      set({
        selectedAgent: agent,
        conversationId: null,
        conversationMessages: [],
        conversationAgentId: null,
      });
    } else {
      set({ selectedAgent: agent });
    }

    if (agent) {
      // Switching to agent mode - persist to cookie
      conversationState.setActiveAgentId(agent.id);

      // Update URL with agent param, clear old conversation ID
      const url = new URL(window.location.href);
      url.searchParams.set('agent', agent.id);
      url.searchParams.delete('c'); // Clear stale conversation ID so most recent loads
      window.history.pushState({}, '', url.toString());

      // Automatically load most recent conversation for this agent
      if (isSwitchingAgent) {
        get().loadMostRecentConversation();
      }
    } else {
      // Switching back to Global Assistant - clear cookie
      conversationState.setActiveAgentId(null);

      // Clear agent from URL
      const url = new URL(window.location.href);
      url.searchParams.delete('agent');
      url.searchParams.delete('c'); // Also clear conversation ID
      window.history.pushState({}, '', url.toString());
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
      const urlAgentId = urlParams.get('agent');
      const cookieAgentId = conversationState.getActiveAgentId();

      const agentId = urlAgentId || cookieAgentId;

      if (agentId) {
        // Fetch agent info to restore selection
        const agentsResponse = await fetchWithAuth('/api/agents/multi-drive?groupByDrive=true');
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
            // Clear URL param as well
            const url = new URL(window.location.href);
            url.searchParams.delete('agent');
            url.searchParams.delete('c');
            window.history.replaceState({}, '', url.toString());
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
   * Load a specific conversation by ID
   */
  loadConversation: async (conversationId: string) => {
    const agent = get().selectedAgent;
    if (!agent) return;

    set({ isConversationLoading: true });

    try {
      const response = await fetchWithAuth(
        `/api/agents/${agent.id}/conversations/${conversationId}/messages`
      );

      if (response.ok) {
        const data = await response.json();
        set({
          conversationId,
          conversationMessages: data.messages || [],
          conversationAgentId: agent.id,
          isConversationLoading: false,
        });

        // Update URL for bookmarkability
        const url = new URL(window.location.href);
        url.searchParams.set('c', conversationId);
        url.searchParams.set('agent', agent.id);
        window.history.pushState({}, '', url.toString());
      } else {
        throw new Error('Failed to load conversation');
      }
    } catch (error) {
      console.error('Failed to load conversation:', error);
      toast.error('Failed to load conversation');
      set({ isConversationLoading: false });
    }
  },

  /**
   * Create a new conversation for the current agent
   */
  createNewConversation: async () => {
    const agent = get().selectedAgent;
    if (!agent) return null;

    set({ isConversationLoading: true });

    try {
      const response = await fetchWithAuth(
        `/api/agents/${agent.id}/conversations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      if (response.ok) {
        const data = await response.json();
        const newConversationId = data.conversationId || data.id;

        set({
          conversationId: newConversationId,
          conversationMessages: [],
          conversationAgentId: agent.id,
          isConversationLoading: false,
        });

        // Update URL for bookmarkability
        const url = new URL(window.location.href);
        url.searchParams.set('c', newConversationId);
        url.searchParams.set('agent', agent.id);
        window.history.pushState({}, '', url.toString());

        return newConversationId;
      } else {
        throw new Error('Failed to create conversation');
      }
    } catch (error) {
      console.error('Failed to create new conversation:', error);
      toast.error('Failed to create new conversation');
      set({ isConversationLoading: false });
      return null;
    }
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
      conversationId: null,
      conversationMessages: [],
      conversationAgentId: null,
    });
  },

  /**
   * Load the most recent conversation for the current agent
   */
  loadMostRecentConversation: async () => {
    const agent = get().selectedAgent;
    if (!agent) return;

    // Check if we already have a conversation for this agent
    if (get().conversationAgentId === agent.id && get().conversationId) {
      return;
    }

    set({ isConversationLoading: true });

    try {
      // Check URL for existing conversation ID first
      const urlParams = new URLSearchParams(window.location.search);
      const conversationIdFromUrl = urlParams.get('c');
      const agentIdFromUrl = urlParams.get('agent');

      // If URL has conversation for THIS agent, load it
      if (conversationIdFromUrl && agentIdFromUrl === agent.id) {
        const response = await fetchWithAuth(
          `/api/agents/${agent.id}/conversations/${conversationIdFromUrl}/messages`
        );

        if (response.ok) {
          const data = await response.json();
          set({
            conversationId: conversationIdFromUrl,
            conversationMessages: data.messages || [],
            conversationAgentId: agent.id,
            isConversationLoading: false,
          });
          return;
        }
      }

      // Try to load most recent conversation
      const response = await fetchWithAuth(
        `/api/agents/${agent.id}/conversations?limit=1`
      );

      if (response.ok) {
        const data = await response.json();
        if (data.conversations && data.conversations.length > 0) {
          const mostRecent = data.conversations[0];

          // Load messages for this conversation
          const messagesResponse = await fetchWithAuth(
            `/api/agents/${agent.id}/conversations/${mostRecent.id}/messages`
          );

          if (messagesResponse.ok) {
            const messagesData = await messagesResponse.json();
            set({
              conversationId: mostRecent.id,
              conversationMessages: messagesData.messages || [],
              conversationAgentId: agent.id,
              isConversationLoading: false,
            });

            // Update URL
            const url = new URL(window.location.href);
            url.searchParams.set('c', mostRecent.id);
            url.searchParams.set('agent', agent.id);
            window.history.pushState({}, '', url.toString());
            return;
          }
        }
      }

      // No existing conversation - create a new one
      await get().createNewConversation();
    } catch (error) {
      console.error('Failed to load most recent conversation:', error);
      set({ isConversationLoading: false });
      // Try to create a new one
      await get().createNewConversation();
    }
  },
}));
