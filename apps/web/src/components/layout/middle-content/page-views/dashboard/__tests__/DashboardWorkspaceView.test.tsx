/**
 * DashboardWorkspaceView — the fallback contract.
 *
 * The dashboard must never blank out: until the workspace is provisioned (or
 * if provisioning fails) the OLD assistant surface shows. Once the GET answers
 * with a workspace id, the pane grid owns the surface and the fallback is
 * gone. The provision request fires exactly once — the tree is the layout's
 * source of truth now, so a conversation-identity change afterwards must not
 * re-provision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import DashboardWorkspaceView from '../DashboardWorkspaceView';
import {
  getRegisteredDashboardWorkspaceId,
  resetDashboardWorkspaceRegistry,
} from '@/lib/agent-workspaces/dashboard-workspace-registry';

const chatState = vi.hoisted(() => ({
  currentConversationId: 'conv-active' as string | null,
}));

const loadConversationMock = vi.fn();

vi.mock('@/contexts/GlobalChatContext', () => ({
  useGlobalChatConversation: () => ({
    currentConversationId: chatState.currentConversationId,
    isInitialized: true,
    setCurrentConversationId: vi.fn(),
    loadConversation: loadConversationMock,
    createNewConversation: vi.fn(),
    rejoinGlobalStream: vi.fn(),
    latestGlobalConversationAdded: null,
  }),
}));

const fetchState = vi.hoisted(() => ({
  fetchJson: vi.fn(),
}));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchState.fetchJson(...args),
}));

const agentPanesProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock('@/components/agents/panes/AgentPanes', () => ({
  default: (props: {
    sessionId: string;
    initialConversation: unknown;
    onActiveConversationChanged?: (c: { conversationId: string; agentPageId: string | null } | null) => void;
  }) => {
    agentPanesProps.current = props as unknown as Record<string, unknown>;
    return (
      <div
        data-testid="agent-panes"
        data-session-id={props.sessionId}
        data-initial-conversation={props.initialConversation ? JSON.stringify(props.initialConversation) : ''}
      />
    );
  },
}));

vi.mock('@/components/layout/middle-content/page-views/dashboard/GlobalAssistantView', () => ({
  default: () => <div data-testid="global-assistant-fallback" />,
}));

vi.mock('@/stores/agent-workspace/useWorkspaceLayoutSync', () => ({
  useWorkspaceLayoutSync: vi.fn(),
}));

describe('DashboardWorkspaceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentPanesProps.current = null;
    resetDashboardWorkspaceRegistry();
    chatState.currentConversationId = 'conv-active';
  });

  it('shows the assistant surface while provisioning, then hands the surface to the grid', async () => {
    fetchState.fetchJson.mockResolvedValueOnce(
      new Response(JSON.stringify({ workspaceId: 'ws-dash', created: true }), { status: 200 }),
    );
    const { rerender } = render(<DashboardWorkspaceView />);
    expect(screen.getByTestId('global-assistant-fallback')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());
    expect(screen.queryByTestId('global-assistant-fallback')).not.toBeInTheDocument();

    rerender(<DashboardWorkspaceView />);
    expect(screen.getByTestId('agent-panes')).toBeInTheDocument();
  });

  it('seeds the grid with the active global conversation as the initial pane', async () => {
    fetchState.fetchJson.mockResolvedValueOnce(
      new Response(JSON.stringify({ workspaceId: 'ws-dash' }), { status: 200 }),
    );
    render(<DashboardWorkspaceView />);

    const grid = await screen.findByTestId('agent-panes');
    expect(grid.getAttribute('data-session-id')).toBe('ws-dash');
    const initial = JSON.parse(grid.getAttribute('data-initial-conversation') ?? '{}');
    expect(initial).toEqual({
      conversationId: 'conv-active',
      agentPageId: null,
      name: 'Global Assistant',
    });
    // The seed binding rides the provision call.
    expect(fetchState.fetchJson).toHaveBeenCalledWith(
      '/api/agent-workspaces/dashboard?conversationId=conv-active',
    );
  });

  it('keeps the fallback on provisioning failure instead of blanking the dashboard', async () => {
    fetchState.fetchJson.mockRejectedValueOnce(new Error('network down'));
    render(<DashboardWorkspaceView />);
    await waitFor(() => expect(fetchState.fetchJson).toHaveBeenCalled());
    expect(screen.getByTestId('global-assistant-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-panes')).not.toBeInTheDocument();
  });
});

describe('DashboardWorkspaceView — identity sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatState.currentConversationId = 'conv-active';
  });

  // The dashboard pane is what is ON SCREEN: when the focused pane changes to
  // a GLOBAL thread, the app-wide identity follows it (sidebar + voice agree
  // with the grid). Agent threads in the grid must NOT touch the identity.
  it('follows the focused pane when it is a global thread, and registers the workspace', async () => {
    fetchState.fetchJson.mockResolvedValueOnce(
      new Response(JSON.stringify({ workspaceId: 'ws-dash' }), { status: 200 }),
    );
    render(<DashboardWorkspaceView />);
    const grid = await screen.findByTestId('agent-panes');

    // Grid registered its workspace for the sidebar's "New" mint path.
    expect(getRegisteredDashboardWorkspaceId()).toBe('ws-dash');

    // Fire the callback the way AgentPanes does when focus lands on the
    // seeded global thread but with a DIFFERENT id than the cookie.
    act(() => {
      gridHandler()?.({ conversationId: 'conv-2', agentPageId: null });
    });
    expect(loadConversationMock).toHaveBeenCalledWith('conv-2');
  });

  it('does NOT touch the identity when the focused pane is an agent thread', async () => {
    fetchState.fetchJson.mockResolvedValueOnce(
      new Response(JSON.stringify({ workspaceId: 'ws-dash' }), { status: 200 }),
    );
    render(<DashboardWorkspaceView />);
    const grid = await screen.findByTestId('agent-panes');

    act(() => {
      gridHandler()?.({ conversationId: 'conv-agent', agentPageId: 'agent-9' });
    });
    expect(loadConversationMock).not.toHaveBeenCalled();

    // And the no-op guard: the same id as the cookie does not re-load.
    act(() => {
      gridHandler()?.({ conversationId: 'conv-active', agentPageId: null });
    });
    expect(loadConversationMock).not.toHaveBeenCalled();
  });
});

// The AgentPanes mock records its props; this digs the conversation callback
// out of the latest render's props. Returns undefined before the grid mounts.
function gridHandler(): ((c: { conversationId: string; agentPageId: string | null } | null) => void) | undefined {
  const props = agentPanesProps.current;
  return props?.onActiveConversationChanged as
    | ((c: { conversationId: string; agentPageId: string | null } | null) => void)
    | undefined;
}
