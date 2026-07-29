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
  current: {
    agent: null as AgentInfo | null,
    isLoading: false,
    error: undefined as Error | undefined,
    retry: vi.fn() as () => void,
  } as { agent: AgentInfo | null; isLoading: boolean; error: Error | undefined; retry: () => void },
}));
vi.mock('../useResolvedAgent', () => ({
  useResolvedAgent: () => resolvedAgent.current,
}));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

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
  resolvedAgent.current = { agent: agentFixture(), isLoading: false, error: undefined , retry: vi.fn() };
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
  toastMock.error.mockClear();
  toastMock.success.mockClear();
});

describe('AgentView', () => {
  it('shows a loading state while the agent is still resolving', () => {
    resolvedAgent.current = { agent: null, isLoading: true, error: undefined , retry: vi.fn() };
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

  it('given the server refuses to add a shell, should tell the user why instead of failing silently', async () => {
    // The refusal this most often carries is the plan's sandbox limit. `post()`
    // rethrows the 429 body's `error` as the Error message, so the sentence the
    // API wrote for a human is already in hand — it just had nowhere to go: the
    // handler was try/finally with no catch, so the rejection escaped an onClick
    // as an unhandled rejection and the user got a spinner that stopped and no
    // tab. A limit the product enforces but never states reads as a bug.
    shellsState.current.addShell = vi.fn(async () => {
      throw new Error("Your plan's limit for running sandboxes is already in use — stop one before starting another.");
    });
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);

    fireEvent.click(screen.getByRole('button', { name: /Add shell/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Could not add a shell', {
        description: "Your plan's limit for running sandboxes is already in use — stop one before starting another.",
      }),
    );
  });

  it('given adding a shell fails, should re-enable the button rather than latch it disabled', async () => {
    shellsState.current.addShell = vi.fn(async () => {
      throw new Error('nope');
    });
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);
    const button = screen.getByRole('button', { name: /Add shell/ });

    fireEvent.click(button);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    // The `finally` must survive the new catch: a permanently disabled button
    // would strand the user even after the condition that refused them clears.
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('given closing a shell fails, should say so — the tab silently comes back', async () => {
    // Removal is optimistic with `rollbackOnError`, so a failure restores the
    // tab. Unexplained, that reads as a click that did not register.
    shellsState.current.shells = [shellFixture({ shellId: 'shell-a', name: 'shell-a' })];
    shellsState.current.removeShell = vi.fn(async () => {
      throw new Error('sandbox unreachable');
    });
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);

    fireEvent.click(screen.getByLabelText('Close shell-a'));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Could not close that shell', {
        description: 'sandbox unreachable',
      }),
    );
  });

  it('shows Starting on the chip while the first shell provisions the sandbox', async () => {
    // There is no explicit "start sandbox" affordance — provisioning is lazy, so
    // adding the first shell IS the cold start the user waits through. Without
    // folding that in, the chip insists "No sandbox" for the whole wait, whose
    // copy ("One starts the first time the agent needs to run something") is
    // false precisely then.
    sessionState.current.status = 'none';
    let release: ((value: ShellDTO | null) => void) | undefined;
    shellsState.current.addShell = vi.fn(
      () => new Promise<ShellDTO | null>((resolve) => { release = resolve; }),
    );
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);
    expect(screen.getByTestId('sandbox-status-chip')).toHaveTextContent('No sandbox');

    fireEvent.click(screen.getByRole('button', { name: /Add shell/ }));

    await waitFor(() =>
      expect(screen.getByTestId('sandbox-status-chip')).toHaveTextContent('Starting'),
    );
    release?.(null);
  });

  it('given a RUNNING sandbox, adding another shell should NOT read as Starting', async () => {
    // The row's own fact outranks a request in flight: a second shell on a live
    // sandbox is not a boot, and saying so would misreport a working sandbox.
    sessionState.current.status = 'running';
    shellsState.current.addShell = vi.fn(() => new Promise<ShellDTO | null>(() => {}));
    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);

    fireEvent.click(screen.getByRole('button', { name: /Add shell/ }));

    await waitFor(() => expect(shellsState.current.addShell).toHaveBeenCalled());
    expect(screen.getByTestId('sandbox-status-chip')).toHaveTextContent('Ready');
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

/**
 * A failed agent load must be visibly distinguishable from a slow one. SWR stops
 * retrying after a genuine failure, so a combined `isLoading || !agent` guard
 * left the user watching a spinner that would never resolve — no error text, no
 * retry, nothing to do but reload the page.
 */
describe('AgentView — failed agent load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given loading finished with no agent, should show an error with a retry rather than spin forever', async () => {
    resolvedAgent.current = {
      agent: null,
      isLoading: false,
      error: new Error('Failed to load agent page: 500'),
      retry: vi.fn(),
    };

    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);

    expect(screen.queryByTestId('agent-view-loading')).toBeNull();
    const error = screen.getByTestId('agent-view-error');
    expect(error).toBeTruthy();
    // The server's reason is surfaced, not swallowed behind a generic message.
    expect(error.textContent).toContain('Failed to load agent page: 500');
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('given the retry button is pressed, should ask the hook to re-fetch', async () => {
    const retry = vi.fn();
    resolvedAgent.current = { agent: null, isLoading: false, error: undefined, retry  };

    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('given still loading, should show the spinner and no error', () => {
    resolvedAgent.current = { agent: null, isLoading: true, error: undefined, retry: vi.fn()  };

    render(<AgentView agentId="agent-1" conversationId="conv-1" context="console" />);

    expect(screen.getByTestId('agent-view-loading')).toBeTruthy();
    expect(screen.queryByTestId('agent-view-error')).toBeNull();
  });
});
