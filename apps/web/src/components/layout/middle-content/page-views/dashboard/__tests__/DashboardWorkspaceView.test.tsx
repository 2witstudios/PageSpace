/**
 * DashboardWorkspaceView — the fallback contract + identity sync.
 *
 * The dashboard must never blank out: until the workspace is provisioned (or
 * if provisioning gives up after its retries) the OLD assistant surface
 * shows. Once the POST answers with a workspace id, the pane grid owns the
 * surface and the fallback is gone. Provisioning is keyed ONCE at mount — the
 * tree is the layout's source of truth, so a later cookie-identity change
 * must not re-provision — and the registration is USER-KEYED: a stale entry
 * from a previous account can never route another user's "New" into it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
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

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isAuthenticated: true }),
}));

const postState = vi.hoisted(() => ({
  post: vi.fn(),
}));
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => postState.post(...args),
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

function renderView() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DashboardWorkspaceView />
    </SWRConfig>,
  );
}

describe('DashboardWorkspaceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT clear once-implementations: test 1's
    // mockResolvedValueOnce would leak into every later test.
    postState.post.mockReset();
    agentPanesProps.current = null;
    resetDashboardWorkspaceRegistry();
    chatState.currentConversationId = 'conv-active';
  });

  it('shows the assistant surface while provisioning, then hands the surface to the grid', async () => {
    postState.post.mockResolvedValueOnce({ workspaceId: 'ws-dash', created: true });
    renderView();
    expect(screen.getByTestId('global-assistant-fallback')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());
    expect(screen.queryByTestId('global-assistant-fallback')).not.toBeInTheDocument();
  });

  it('seeds the grid with the mount-time conversation as the initial pane, POSTing the provision', async () => {
    postState.post.mockResolvedValueOnce({ workspaceId: 'ws-dash' });
    renderView();

    const grid = await screen.findByTestId('agent-panes');
    expect(grid.getAttribute('data-session-id')).toBe('ws-dash');
    const initial = JSON.parse(grid.getAttribute('data-initial-conversation') ?? '{}');
    expect(initial).toEqual({
      conversationId: 'conv-active',
      agentPageId: null,
      name: 'Global Assistant',
    });
    expect(postState.post).toHaveBeenCalledWith('/api/agent-workspaces/dashboard', {
      conversationId: 'conv-active',
    });
  });

  it('keeps the fallback when provisioning gives up instead of blanking the dashboard', async () => {
    postState.post.mockRejectedValue(new Error('network down'));
    renderView();
    // SWR retries 3x before surfacing the error — the fallback owns the
    // surface throughout, and the grid never mounts.
    await waitFor(
      () => expect(screen.queryByTestId('agent-panes')).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByTestId('global-assistant-fallback')).toBeInTheDocument();
  });
});

describe('DashboardWorkspaceView — identity sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT clear once-implementations: test 1's
    // mockResolvedValueOnce would leak into every later test.
    postState.post.mockReset();
    agentPanesProps.current = null;
    resetDashboardWorkspaceRegistry();
    chatState.currentConversationId = 'conv-active';
  });

  // The dashboard pane is what is ON SCREEN: when the focused pane changes to
  // a GLOBAL thread, the app-wide identity follows it (sidebar + voice agree
  // with the grid). Agent threads in the grid must NOT touch the identity.
  it('follows the focused pane when it is a global thread, and registers the workspace for the signed-in user', async () => {
    postState.post.mockResolvedValueOnce({ workspaceId: 'ws-dash' });
    renderView();
    await screen.findByTestId('agent-panes');

    // Grid registered its workspace AGAINST THE USER — the sidebar's "New"
    // mint path reads it user-keyed.
    expect(getRegisteredDashboardWorkspaceId('u1')).toBe('ws-dash');

    act(() => {
      gridHandler()?.({ conversationId: 'conv-2', agentPageId: null });
    });
    expect(loadConversationMock).toHaveBeenCalledWith('conv-2');
  });

  it('does NOT touch the identity when the focused pane is an agent thread', async () => {
    postState.post.mockResolvedValueOnce({ workspaceId: 'ws-dash' });
    renderView();
    await screen.findByTestId('agent-panes');

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
