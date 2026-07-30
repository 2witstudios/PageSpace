/**
 * The console shell.
 *
 * Two structural properties and one rendering contract:
 *
 * - It hydrates its selection from the URL on mount (deep link, refresh) and
 *   re-hydrates on `popstate` (Back/Forward). Together those are what let
 *   selection live in the query string instead of the route, which is what
 *   lets this component stay mounted through every click.
 * - The centre is the SESSION's pane grid, keyed by the session id — switching
 *   sessions swaps the grid; nothing else about the shell changes.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

vi.mock('../panes/AgentPanes', () => ({
  default: ({
    sessionId,
    driveId,
    initialConversation,
  }: {
    sessionId: string;
    driveId: string | null;
    initialConversation: { conversationId: string; agentPageId: string | null };
  }) => (
    <div data-testid="agent-panes" data-drive-id={driveId ?? 'none'}>
      {sessionId}/{initialConversation.conversationId}/{initialConversation.agentPageId ?? 'no-agent'}
    </div>
  ),
}));

const mockFetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import AgentsSurface from '../AgentsSurface';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';

beforeEach(() => {
  // A selected session exists by default — the tests that care about a GONE
  // session (finding 6's GC) set their own `{ session: null }` response.
  mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ session: { driveId: null } }) });
  window.history.replaceState({}, '', '/dashboard/agents');
  useAgentSurfaceStore.setState({
    driveId: null,
    selectedSessionId: null,
    selectedConversationId: null,
    selectedAgentId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentsSurface', () => {
  test('hydrates the selection from a deep link on mount', () => {
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');

    render(<AgentsSurface />);

    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
  });

  test('records the drive it is mounted under, so selections stay in this surface', () => {
    render(<AgentsSurface driveId="drive-1" />);
    expect(useAgentSurfaceStore.getState().driveId).toBe('drive-1');
  });

  test('the global surface has no drive scope', () => {
    useAgentSurfaceStore.setState({ driveId: 'stale-drive' });
    render(<AgentsSurface />);
    expect(useAgentSurfaceStore.getState().driveId).toBeNull();
  });

  test('re-hydrates on Back — the browser restores the URL, the store follows it', () => {
    render(<AgentsSurface />);

    act(() => {
      window.history.replaceState({}, '', '/dashboard/agents?session=ses-2&c=conv-2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-2');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-2');
  });

  test('stops listening for popstate once unmounted', () => {
    const { unmount } = render(<AgentsSurface />);
    unmount();

    act(() => {
      window.history.replaceState({}, '', '/dashboard/agents?session=ses-3');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull();
  });

  test('prompts for a selection when nothing is open', () => {
    render(<AgentsSurface />);
    expect(screen.getByText('Select a session')).toBeDefined();
  });

  test('a session with no conversation is the degenerate deep link, not the grid', () => {
    // The sidebar always writes session AND conversation together; only a
    // hand-trimmed URL lands here. It must render a prompt, never a
    // speculative pane grid for a conversation that isn't named.
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1');
    render(<AgentsSurface />);
    expect(screen.getByText('Pick a conversation')).toBeDefined();
    expect(screen.queryByTestId('agent-panes')).toBeNull();
  });

  test('renders the pane grid, keyed by the session, once a conversation is selected', () => {
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1&c=conv-1&agent=agent-1');
    render(<AgentsSurface />);
    expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-1/agent-1');
  });

  test('a conversation with no agent still renders the grid', () => {
    // Global-assistant conversations have no agent page; the grid (not this
    // shell) owns what that pane shows.
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-1&c=conv-1');
    render(<AgentsSurface />);
    expect(screen.getByTestId('agent-panes')).toHaveTextContent('ses-1/conv-1/no-agent');
  });
});

describe('GC when the server says the session is gone (issue #2263, finding 6)', () => {
  beforeEach(() => {
    useAgentWorkspaceStore.setState({ workspaces: {} });
  });

  it('forgets the persisted grid and backs out to the empty state', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ session: null }) });
    useAgentWorkspaceStore.getState().ensureWorkspace('ses-gone', {
      kind: 'chat',
      name: 'x',
      targetId: 'conv-1',
      agentPageId: 'agent-1',
    });
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-gone&c=conv-1&agent=agent-1');

    render(<AgentsSurface />);

    await waitFor(() => expect(useAgentSurfaceStore.getState().selectedSessionId).toBeNull());
    expect(useAgentWorkspaceStore.getState().workspaces['ses-gone']).toBeUndefined();
    expect(screen.getByText('Select a session')).toBeDefined();
  });

  it('a session the server confirms exists is left untouched', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ session: { driveId: null } }) });
    useAgentWorkspaceStore.getState().ensureWorkspace('ses-live', {
      kind: 'chat',
      name: 'x',
      targetId: 'conv-1',
      agentPageId: 'agent-1',
    });
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-live&c=conv-1&agent=agent-1');

    render(<AgentsSurface />);

    await waitFor(() => expect(screen.getByTestId('agent-panes')).toBeInTheDocument());
    expect(useAgentSurfaceStore.getState().selectedSessionId).toBe('ses-live');
    expect(useAgentWorkspaceStore.getState().workspaces['ses-live']).toBeDefined();
  });
});

describe('the grid gets the SESSION\'s drive, not the surface\'s (review M5)', () => {
  it('in global mode, a drive session\'s picker still knows its drive', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ session: { driveId: 'drive-7' } }),
    });
    // A session id no earlier test fetched — SWR's cache is module-global and
    // this key's first answer would otherwise win for 30s.
    window.history.replaceState({}, '', '/dashboard/agents?session=ses-m5&c=conv-1&agent=agent-1');
    render(<AgentsSurface />);

    await waitFor(() =>
      expect(screen.getByTestId('agent-panes')).toHaveAttribute('data-drive-id', 'drive-7'),
    );
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/agent-sessions/ses-m5');
  });
});
