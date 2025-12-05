/**
 * RightPanel Integration Tests
 * Tests for navigation transition behavior and state transfer between dashboard and sidebar
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { usePageAgentDashboardStore } from '@/stores/page-agents/usePageAgentDashboardStore';
import { useSidebarAgentStore } from '@/hooks/page-agents/usePageAgentSidebarState';
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

const mockMessages = [
  { id: 'msg-1', role: 'user', content: 'Hello' },
  { id: 'msg-2', role: 'assistant', content: 'Hi!' },
] as never[];

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
 * Performs the transfer operation as done in RightPanel
 */
function performDashboardToSidebarTransfer(): void {
  const dashboardState = usePageAgentDashboardStore.getState();
  if (dashboardState.selectedAgent) {
    useSidebarAgentStore.getState().transferFromDashboard({
      agent: dashboardState.selectedAgent,
      conversationId: dashboardState.conversationId,
      messages: dashboardState.conversationMessages,
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
      conversationMessages: [],
      isConversationLoading: false,
      conversationAgentId: null,
      activeTab: 'history',
    });

    useSidebarAgentStore.setState({
      selectedAgent: null,
      conversationId: null,
      initialMessages: [],
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
    it('given agent selected on dashboard, should transfer to sidebar on navigation', () => {
      // Set up dashboard state
      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'dashboard-conv-123',
        conversationMessages: mockMessages,
        conversationAgentId: mockAgent.id,
      });

      // Verify sidebar is initially empty
      expect(useSidebarAgentStore.getState().selectedAgent).toBeNull();

      // Perform transfer
      performDashboardToSidebarTransfer();

      // Verify sidebar received the state
      const sidebarState = useSidebarAgentStore.getState();
      expect(sidebarState.selectedAgent).toEqual(mockAgent);
      expect(sidebarState.conversationId).toBe('dashboard-conv-123');
      expect(sidebarState.initialMessages).toEqual(mockMessages);
      expect(sidebarState.isInitialized).toBe(true);
    });

    it('given no agent on dashboard, should not transfer anything', () => {
      // Dashboard has no agent selected
      usePageAgentDashboardStore.setState({
        selectedAgent: null,
        conversationId: null,
        conversationMessages: [],
      });

      // Perform transfer (should be no-op)
      performDashboardToSidebarTransfer();

      // Sidebar should remain empty
      const sidebarState = useSidebarAgentStore.getState();
      expect(sidebarState.selectedAgent).toBeNull();
      expect(sidebarState.conversationId).toBeNull();
    });

    it('given agent with empty conversation, should transfer agent without messages', () => {
      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: null,
        conversationMessages: [],
        conversationAgentId: mockAgent.id,
      });

      performDashboardToSidebarTransfer();

      const sidebarState = useSidebarAgentStore.getState();
      expect(sidebarState.selectedAgent).toEqual(mockAgent);
      expect(sidebarState.conversationId).toBeNull();
      expect(sidebarState.initialMessages).toEqual([]);
    });

    it('given streaming conversation on dashboard, should transfer current messages', () => {
      // Simulate streaming - dashboard has partial message
      const streamingMessages = [
        { id: 'msg-1', role: 'user', content: 'Hello' },
        { id: 'msg-2', role: 'assistant', content: 'I am currently...' },
      ] as never[];

      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'streaming-conv',
        conversationMessages: streamingMessages,
      });

      performDashboardToSidebarTransfer();

      const sidebarState = useSidebarAgentStore.getState();
      expect(sidebarState.initialMessages).toEqual(streamingMessages);
      // Access the raw object since we're using as never[]
      expect((sidebarState.initialMessages[1] as unknown as { content: string }).content).toBe('I am currently...');
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
        conversationMessages: mockMessages,
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
        conversationMessages: [],
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
        initialMessages: [{ id: 'old-msg', role: 'user', content: 'Old' }] as never[],
        isInitialized: true,
        agentIdForConversation: otherAgent.id,
      });

      // Dashboard has different agent
      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'new-conv',
        conversationMessages: mockMessages,
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
        conversationMessages: mockMessages,
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
        conversationMessages: mockMessages,
      });

      performDashboardToSidebarTransfer();

      expect(useSidebarAgentStore.getState().selectedAgent).toEqual(fullAgent);
    });

    it('given very long conversation history, should transfer all messages', () => {
      const longHistory = Array.from({ length: 100 }, (_, i) => ({
        id: `msg-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        parts: [{ type: 'text', text: `Message ${i}` }],
      })) as never[];

      usePageAgentDashboardStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'long-conv',
        conversationMessages: longHistory,
      });

      performDashboardToSidebarTransfer();

      expect(useSidebarAgentStore.getState().initialMessages).toHaveLength(100);
    });
  });
});
