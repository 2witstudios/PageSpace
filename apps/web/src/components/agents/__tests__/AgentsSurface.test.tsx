/**
 * The console shell.
 *
 * There is almost nothing here yet — the session view lands next — but the two
 * things that ARE here are the ones the whole surface rests on: it hydrates its
 * selection from the URL on mount (deep link, refresh) and re-hydrates on
 * `popstate` (Back/Forward). Together those are what let selection live in the
 * query string instead of the route, which is what lets this component stay
 * mounted through every click.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('../AgentView', () => ({
  default: ({ agentId, conversationId }: { agentId: string; conversationId: string }) => (
    <div data-testid="agent-view">
      {agentId}/{conversationId}
    </div>
  ),
}));

import AgentsSurface from '../AgentsSurface';
import { useAgentSurfaceStore } from '@/stores/agents/useAgentSurfaceStore';

beforeEach(() => {
  window.history.replaceState({}, '', '/dashboard/agents');
  useAgentSurfaceStore.setState({ driveId: null, selectedAgentId: null, selectedConversationId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentsSurface', () => {
  test('hydrates the selection from a deep link on mount', () => {
    window.history.replaceState({}, '', '/dashboard/agents?agent=agent-1&c=conv-1');

    render(<AgentsSurface />);

    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-1');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-1');
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
      window.history.replaceState({}, '', '/dashboard/agents?agent=agent-2&c=conv-2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(useAgentSurfaceStore.getState().selectedAgentId).toBe('agent-2');
    expect(useAgentSurfaceStore.getState().selectedConversationId).toBe('conv-2');
  });

  test('stops listening for popstate once unmounted', () => {
    const { unmount } = render(<AgentsSurface />);
    unmount();

    act(() => {
      window.history.replaceState({}, '', '/dashboard/agents?agent=agent-3');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(useAgentSurfaceStore.getState().selectedAgentId).toBeNull();
  });

  test('prompts for a selection when nothing is open', () => {
    render(<AgentsSurface />);
    expect(screen.getByText('Select an agent')).toBeDefined();
  });

  test('acknowledges a selection instead of repeating the prompt', () => {
    // A user who just clicked an agent should see that the click landed, not the
    // same instruction telling them to click one.
    window.history.replaceState({}, '', '/dashboard/agents?agent=agent-1');
    render(<AgentsSurface />);
    expect(screen.queryByText('Select an agent')).toBeNull();
  });

  test('says nothing about "sessions" — that word is not the user\'s', () => {
    window.history.replaceState({}, '', '/dashboard/agents?agent=agent-1&c=conv-1');
    const { container } = render(<AgentsSurface />);
    expect(container.textContent?.toLowerCase()).not.toContain('session');
  });

  test('renders AgentView, keyed by conversationId, once both an agent and a conversation are selected', () => {
    window.history.replaceState({}, '', '/dashboard/agents?agent=agent-1&c=conv-1');
    render(<AgentsSurface />);
    expect(screen.getByTestId('agent-view')).toHaveTextContent('agent-1/conv-1');
  });
});
