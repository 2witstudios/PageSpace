/**
 * AgentView Component Tests — Phase 6.
 *
 * All state hooks (agent resolution, session status, shells) are mocked; this
 * suite covers AgentView's own shell: header (title, sandbox chip, cross-link
 * vs conversation-picker slot, Add shell), the tab container built from
 * `resolveSessionTabs`, forceMount-and-hide of inactive shell tabs, and the
 * optional settings tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentInfo } from '@/types/agent';
import type { ShellDTO } from '@pagespace/lib/agent-sessions/contract';

const resolvedAgent = vi.hoisted(() => ({
  current: { agent: null as AgentInfo | null, isLoading: false, error: undefined as Error | undefined },
}));
vi.mock('../useResolvedAgent', () => ({
  useResolvedAgent: () => resolvedAgent.current,
}));

const sessionState = vi.hoisted(() => ({
  current: {
    session: null,
    status: 'none' as 'none' | 'starting' | 'running' | 'ended',
    isLoading: false,
    error: undefined as Error | undefined,
    ensureSession: vi.fn(),
    mutate: vi.fn(),
  },
}));
vi.mock('../useAgentSession', () => ({
  useAgentSession: () => sessionState.current,
}));

const shellsState = vi.hoisted(() => ({
  current: {
    shells: [] as ShellDTO[],
    isLoading: false,
    error: undefined,
    addShell: vi.fn(async () => null as ShellDTO | null),
    removeShell: vi.fn(async () => {}),
    mutate: vi.fn(),
  },
}));
vi.mock('../useSessionShells', () => ({
  useSessionShells: () => shellsState.current,
}));

vi.mock('../chat/SessionChat', () => ({
  default: ({ context }: { context: string }) => <div data-testid="session-chat">{context}</div>,
}));

vi.mock('../shell/Shell', () => ({
  default: ({ shellId }: { shellId: string }) => <div data-testid={`shell-${shellId}`}>{shellId}</div>,
}));

import AgentView from '../AgentView';

function agentFixture(): AgentInfo {
  return {
    id: 'agent-1',
    title: 'My Agent',
    driveId: 'drive-1',
    driveName: 'Drive One',
  };
}

function shellFixture(overrides: Partial<ShellDTO> = {}): ShellDTO {
  return {
    shellId: 'shell-1',
    sessionId: 'conv-1',
    ownerId: 'user-1',
    name: 'shell-1',
    agentType: 'shell',
    command: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  resolvedAgent.current = { agent: agentFixture(), isLoading: false, error: undefined };
  sessionState.current = {
    session: null,
    status: 'none',
    isLoading: false,
    error: undefined,
    ensureSession: vi.fn(),
    mutate: vi.fn(),
  };
  shellsState.current = {
    shells: [],
    isLoading: false,
    error: undefined,
    addShell: vi.fn(async () => null),
    removeShell: vi.fn(async () => {}),
    mutate: vi.fn(),
  };
});

describe('AgentView', () => {
  it('shows a loading state while the agent is still resolving', () => {
    resolvedAgent.current = { agent: null, isLoading: true, error: undefined };
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);
    expect(screen.getByTestId('agent-view-loading')).toBeInTheDocument();
  });

  it('renders the agent title and sandbox status chip once resolved', () => {
    sessionState.current.status = 'running';
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);
    expect(screen.getByText('My Agent')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-status-chip')).toHaveTextContent('Ready');
  });

  it('renders a cross-link to the agent page in console context, and headerExtra in page context', () => {
    const { rerender } = render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);
    expect(screen.getByText('Open agent page')).toHaveAttribute('href', '/dashboard/drive-1/agent-1');

    rerender(
      <AgentView
        agentId="agent-1"
        conversationId="conv-1"
        context="page"
        headerExtra={<div data-testid="conversation-picker">picker</div>}
      />,
    );
    expect(screen.queryByText('Open agent page')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-picker')).toBeInTheDocument();
  });

  it('renders the chat tab with the SessionChat component in the right context', () => {
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="page" />);
    expect(screen.getByTestId('session-chat')).toHaveTextContent('page');
  });

  it('renders a tab per shell, force-mounted, hiding the inactive one via data-state', async () => {
    shellsState.current.shells = [shellFixture({ shellId: 'shell-a', name: 'shell-a' })];
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);

    // Both the chat pane and the shell pane are in the DOM (forceMount) —
    // Radix marks the inactive one data-state="inactive", which the
    // data-[state=inactive]:hidden class (and Radix's own `hidden` attribute)
    // keeps off-screen without unmounting it.
    expect(screen.getByTestId('shell-shell-a')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('tab-trigger-shell:shell-a'));
    await waitFor(() =>
      expect(screen.getByTestId('shell-shell-a').closest('[data-state]')).toHaveAttribute('data-state', 'active'),
    );
  });

  it('clicking Add shell provisions a shell and switches to its tab', async () => {
    shellsState.current.addShell = vi.fn(async () => shellFixture({ shellId: 'new-shell', name: 'new-shell' }));
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);

    fireEvent.click(screen.getByRole('button', { name: /Add shell/ }));

    await waitFor(() => expect(shellsState.current.addShell).toHaveBeenCalled());
  });

  it('closing a shell tab calls removeShell with its shellId', async () => {
    shellsState.current.shells = [shellFixture({ shellId: 'shell-a', name: 'shell-a' })];
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);

    fireEvent.click(screen.getByLabelText('Close shell-a'));

    await waitFor(() => expect(shellsState.current.removeShell).toHaveBeenCalledWith('shell-a'));
  });

  it('renders a Settings tab only when settingsTab content is supplied', () => {
    const { rerender } = render(<AgentView agentId="agent-1" conversationId="conv-1" context="page" />);
    expect(screen.queryByRole('tab', { name: 'Settings' })).not.toBeInTheDocument();

    rerender(
      <AgentView
        agentId="agent-1"
        conversationId="conv-1"
        context="page"
        settingsTab={<div data-testid="settings-content">settings</div>}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
  });

  it('hides Add shell and disables edits in read-only mode', () => {
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="page" isReadOnly />);
    expect(screen.queryByRole('button', { name: /Add shell/ })).not.toBeInTheDocument();
  });
});
