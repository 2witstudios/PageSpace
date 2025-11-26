import { create } from 'zustand';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { conversationState } from '@/lib/ai/conversation-state';

/**
 * Agent information for the selected agent
 * null = Global Assistant mode (no agent selected)
 */
export interface AgentInfo {
  id: string;
  title: string;
  driveId: string;
  driveName: string;
  systemPrompt?: string;
  aiProvider?: string;
  aiModel?: string;
  enabledTools?: string[];
}

interface AgentState {
  // Selected agent (null = Global Assistant mode)
  selectedAgent: AgentInfo | null;

  // Initialization state
  isInitialized: boolean;

  // Methods
  selectAgent: (agent: AgentInfo | null) => void;
  initializeFromUrlOrCookie: () => Promise<void>;
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  selectedAgent: null,
  isInitialized: false,

  /**
   * Select an agent (or null for Global Assistant)
   * This updates the UI state and persists to cookie
   */
  selectAgent: (agent: AgentInfo | null) => {
    set({ selectedAgent: agent });

    if (agent) {
      // Switching to agent mode - persist to cookie
      conversationState.setActiveAgentId(agent.id);

      // Update URL with agent param, clear old conversation ID
      const url = new URL(window.location.href);
      url.searchParams.set('agent', agent.id);
      url.searchParams.delete('c'); // Clear stale conversation ID so most recent loads
      window.history.pushState({}, '', url.toString());
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
            // Agent not found - clear stale cookie
            conversationState.setActiveAgentId(null);
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
}));
