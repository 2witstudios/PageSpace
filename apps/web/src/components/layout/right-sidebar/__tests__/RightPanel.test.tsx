/**
 * RightPanel Integration Tests
 * Tests for navigation transition behavior and state transfer between dashboard and sidebar
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { useSidebarAgentStore } from '@/hooks/page-agents';
import type { AgentInfo } from '@/types/agent';

// Mock dependencies
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ conversations: [] }),
  }),
}));

vi.mock('@/lib/ai/core/conversation-state', () => ({
  conversationState: {
    getActiveAgentId: vi.fn(() => null),
    setActiveAgentId: vi.fn(),
    getActiveConversationId: vi.fn(() => null),
    setActiveConversationId: vi.fn(),
    createAndSetActiveConversation: vi.fn().mockResolvedValue({ id: 'new-conv' }),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ============================================
// Test Data
// ============================================

const mockAgent: AgentInfo = {
  id: 'agent-123',
  title: 'Test Agent',
  driveId: 'drive-456',
  driveName: 'Test Drive',
  systemPrompt: 'You are helpful',
  aiProvider: 'openai',
  aiModel: 'gpt-4',
  enabledTools: ['search'],
};


// ============================================
// Helper Functions
// ============================================

/**
 * Simulates the transfer logic from RightPanel's useEffect
 * This is extracted to test in isolation
 */
function simulateNavigationTransfer(
  prevIsDashboardContext: boolean,
  currentIsDashboardContext: boolean
): boolean {
  // Returns true if transfer should happen
  return prevIsDashboardContext && !currentIsDashboardContext;
}

/**
 * Performs the transfer operation as done in RightPanel.
 * Agent + conversationId ONLY (PR 5B, leaf 5.3.3): the shared conversation cache
 * already holds the conversation's messages — no messages payload travels here.
 */
function performDashboardToSidebarTransfer(): void {
  const dashboardState = usePageAgentDashboardStore.getState();
  if (dashboardState.selectedAgent) {
    useSidebarAgentStore.getState().transferFromDashboard({
      agent: dashboardState.selectedAgent,
      conversationId: dashboardState.conversationId,
    });
  }
}

// ============================================
// Tests
// ============================================

describe('RightPanel Navigation Transition', () => {
  beforeEach(() => {
    // Reset stores to initial state
    usePageAgentDashboardStore.setState({
      selectedAgent: null,
      isInitialized: false,
      conversationId: null,
      isConversationLoading: false,
      conversationAgentId: null,
      activeTab: 'history',
    });

    useSidebarAgentStore.setState({
      selectedAgent: null,
      conversationId: null,
      isInitialized: false,
      agentIdForConversation: null,
      _loadingAgentId: null,
    });

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ============================================
  // Navigation Detection Tests
  // ============================================

  describe('Navigation Detection', () => {
    it('given dashboard to page transition, should detect transfer needed', () => {
      const shouldTransfer = simulateNavigationTransfer(true, false);
      expect(shouldTransfer).toBe(true);
    });

    it('given page to dashboard transition, should not trigger transfer', () => {
      const shouldTransfer = simulateNavigationTransfer(false, true);
      expect(shouldTransfer).toBe(false);
    });

    it('given staying on dashboard, should not trigger transfer', () => {
      const shouldTransfer = simulateNavigationTransfer(true, true);
      expect(shouldTransfer).toBe(false);
    });

    it('given staying on page, should not trigger transfer', () => {
      const shouldTransfer = simulateNavigationTransfer(false, false);
      expect(shouldTransfer).toBe(false);
    });
  });

  // ============================================
  // Agent State Transfer Tests
  // ============================================

  describe('Agent State Transfer', () => {
    it('given agent selected on dashboard, should transfer selection + conversation identity to sidebar on navigation', () => {
      // Set up dashboard state
      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'dashboard-conv-123',
        conversationAgentId: mockAgent.id,
      });

      // Verify sidebar is initially empty
      expect(useSidebarAgentStore.getState().selectedAgent).toBeNull();

      // Perform transfer
      performDashboardToSidebarTransfer();

      // Verify sidebar received the state — messages live in the shared cache,
      // keyed by this same conversationId, so identity is all that must travel.
      const sidebarState = useSidebarAgentStore.getState();
      expect(sidebarState.selectedAgent).toEqual(mockAgent);
      expect(sidebarState.conversationId).toBe('dashboard-conv-123');
      expect(sidebarState.isInitialized).toBe(true);
    });

    it('given no agent on dashboard, should not transfer anything', () => {
      // Dashboard has no agent selected
      usePageAgentDashboardStore.setState({
        selectedAgent: null,
        conversationId: null,
      });

      // Perform transfer (should be no-op)
      performDashboardToSidebarTransfer();

      // Sidebar should remain empty
      const sidebarState = useSidebarAgentStore.getState();
      expect(sidebarState.selectedAgent).toBeNull();
      expect(sidebarState.conversationId).toBeNull();
    });

    it('given agent with no conversation yet, should transfer the agent with null conversationId', () => {
      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: null,
        conversationAgentId: mockAgent.id,
      });

      performDashboardToSidebarTransfer();

      const sidebarState = useSidebarAgentStore.getState();
      expect(sidebarState.selectedAgent).toEqual(mockAgent);
      expect(sidebarState.conversationId).toBeNull();
    });
  });

  // ============================================
  // State Consistency Tests
  // ============================================

  describe('State Consistency', () => {
    it('given transfer, sidebar agentIdForConversation should match agent id', () => {
      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'conv-123',
      });

      performDashboardToSidebarTransfer();

      expect(useSidebarAgentStore.getState().agentIdForConversation).toBe(mockAgent.id);
    });

    it('given transfer, should clear any pending loading state in sidebar', () => {
      // Simulate sidebar was loading
      useSidebarAgentStore.setState({
        _loadingAgentId: 'some-other-agent',
        isInitialized: false,
      });

      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'conv-123',
      });

      performDashboardToSidebarTransfer();

      expect(useSidebarAgentStore.getState()._loadingAgentId).toBeNull();
      expect(useSidebarAgentStore.getState().isInitialized).toBe(true);
    });

    it('given transfer, should replace any existing sidebar agent', () => {
      const otherAgent: AgentInfo = {
        id: 'other-agent',
        title: 'Other Agent',
        driveId: 'drive-789',
        driveName: 'Other Drive',
      };

      // Sidebar already has an agent
      useSidebarAgentStore.setState({
        selectedAgent: otherAgent,
        conversationId: 'old-conv',
        isInitialized: true,
        agentIdForConversation: otherAgent.id,
      });

      // Dashboard has different agent
      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'new-conv',
      });

      performDashboardToSidebarTransfer();

      // Sidebar should have new agent from dashboard
      const sidebarState = useSidebarAgentStore.getState();
      expect(sidebarState.selectedAgent?.id).toBe(mockAgent.id);
      expect(sidebarState.conversationId).toBe('new-conv');
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe('Edge Cases', () => {
    it('given multiple rapid navigations, should handle correctly', () => {
      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'conv-1',
      });

      // Multiple transfers
      performDashboardToSidebarTransfer();
      performDashboardToSidebarTransfer();
      performDashboardToSidebarTransfer();

      // Should still be consistent
      const sidebarState = useSidebarAgentStore.getState();
      expect(sidebarState.selectedAgent).toEqual(mockAgent);
      expect(sidebarState.isInitialized).toBe(true);
    });

    it('given agent with all optional fields, should transfer completely', () => {
      const fullAgent: AgentInfo = {
        id: 'full-agent',
        title: 'Full Agent',
        driveId: 'drive-123',
        driveName: 'Full Drive',
        systemPrompt: 'You are a very detailed assistant',
        aiProvider: 'anthropic',
        aiModel: 'claude-3',
        enabledTools: ['search', 'calendar', 'calculator'],
      };

      usePageAgentDashboardStore.setState({
        selectedAgent: fullAgent,
        conversationId: 'full-conv',
      });

      performDashboardToSidebarTransfer();

      expect(useSidebarAgentStore.getState().selectedAgent).toEqual(fullAgent);
    });
  });
});
