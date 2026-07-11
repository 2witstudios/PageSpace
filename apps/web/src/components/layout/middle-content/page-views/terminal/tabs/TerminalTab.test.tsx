import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// TerminalWorkspace pulls in the xterm/socket subtree — stub it so the tab's
// own composition (tree sidebar + workspace pane) is what's under test.
vi.mock('../workspace/TerminalWorkspace', () => ({
  default: ({ machineId }: { machineId: string }) => (
    <div data-testid="terminal-workspace">workspace:{machineId}</div>
  ),
}));

vi.mock('@/hooks/useMachineProjects', () => ({
  useMachineProjects: () => ({ projects: [], isLoading: false, addProject: vi.fn(), removeProject: vi.fn() }),
}));
vi.mock('@/hooks/useMachineBranches', () => ({
  useMachineBranches: () => ({ branches: [], isLoading: false, addBranch: vi.fn(), removeBranch: vi.fn() }),
}));
vi.mock('@/hooks/useGithubRepos', () => ({
  useGithubRepos: () => ({ repos: [], connected: true, isLoading: false, error: undefined, mutate: vi.fn() }),
}));
vi.mock('@/hooks/useIntegrations', () => ({ useProviders: () => ({ providers: [] }) }));

const addAgentTerminal = vi.fn();
const removeAgentTerminal = vi.fn();
vi.mock('@/hooks/useAgentTerminals', () => ({
  useAgentTerminals: (machineId: string | null) => ({
    // Only the (expanded) Machine-root node fetches in this test; return one
    // session leaf there so we can click it.
    agentTerminals: machineId
      ? [{ name: 'main', agentType: 'claude', createdAt: '2026-01-01' }]
      : [],
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
    addAgentTerminal,
    removeAgentTerminal,
  }),
}));

const openTerminal = vi.fn();
vi.mock('@/stores/terminal-workspace/useTerminalWorkspaceStore', () => ({
  useTerminalWorkspaceStore: (selector: (s: { openTerminal: typeof openTerminal }) => unknown) =>
    selector({ openTerminal }),
}));

import TerminalTab from './TerminalTab';

describe('TerminalTab', () => {
  beforeEach(() => vi.clearAllMocks());

  test('renders the machine tree sidebar beside the terminal workspace pane', async () => {
    render(<TerminalTab machineId="machine-1" />);

    // TerminalWorkspace is a next/dynamic(ssr:false) import, so it resolves a tick later.
    const workspace = await screen.findByTestId('terminal-workspace');

    assert({
      given: 'the Terminal tab for a machine',
      should: 'render both the Machine tree and the workspace pane, scoped to the machineId',
      actual: {
        // queryByText returns null (not a throw) when absent, so this is a real boolean.
        tree: screen.queryByText('Machine') !== null,
        workspace: workspace.textContent,
      },
      expected: { tree: true, workspace: 'workspace:machine-1' },
    });
  });

  test('clicking a session leaf opens that terminal in the shared workspace store', async () => {
    render(<TerminalTab machineId="machine-1" />);

    // The machine root is expanded by default, so its session leaf is visible.
    const session = await waitFor(() => screen.getByText('main'));
    await userEvent.click(session);

    assert({
      given: 'a session leaf under the machine root clicked',
      should: 'call openTerminal(machineId, machine-scoped scope) — not prop-thread through a parent',
      actual: openTerminal.mock.calls[0],
      expected: ['machine-1', { projectName: undefined, branchName: undefined, name: 'main' }],
    });
  });
});
