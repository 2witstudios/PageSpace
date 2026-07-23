import { describe, test, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import { useMachineWorkspaceStore, selectMachine } from '@/stores/machine-workspace/useMachineWorkspaceStore';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// MachineWorkspace pulls in the xterm/socket subtree — stub it so the tab's
// own composition (tree sidebar + workspace pane) is what's under test.
vi.mock('../workspace/MachineWorkspace', () => ({
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
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify({ agentTerminals: [] }), { status: 200 })),
  post: vi.fn(async () => ({ agentTerminal: { name: 'shell-a1b2c3', agentType: 'shell', resumed: false } })),
  del: vi.fn(async () => new Response(null, { status: 204 })),
}));

import TerminalTab from './TerminalTab';

const store = () => useMachineWorkspaceStore.getState();

describe('TerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useMachineWorkspaceStore.setState({ machines: {} });
  });

  test('renders the machine tree sidebar beside the terminal workspace pane', async () => {
    render(<TerminalTab machineId="machine-1" />);

    // MachineWorkspace is a next/dynamic(ssr:false) import, so it resolves a tick later.
    const workspace = await screen.findByTestId('terminal-workspace');

    assert({
      given: 'the Terminal tab for a machine, standalone (not embedded)',
      should: 'render both the Machine tree and the workspace pane, scoped to the machineId',
      actual: {
        tree: screen.queryByText('Machine') !== null,
        workspace: workspace.textContent,
      },
      expected: { tree: true, workspace: 'workspace:machine-1' },
    });
  });

  test('clicking a workspace row switches the machine\'s active workspace', async () => {
    render(<TerminalTab machineId="machine-1" />);

    // The machine root is expanded by default, so its auto-created first
    // workspace's row is visible without any expansion click. Creating a
    // second workspace makes IT the active one (addWorkspace shows what it
    // creates) — clicking back to the first is the real switch under test.
    act(() => {
      store().createWorkspace('machine-1');
    });
    const first = await waitFor(() => screen.getByText('Workspace 1'));
    await userEvent.click(first);

    await waitFor(() => {
      const machine = selectMachine('machine-1')(store())!;
      assert({
        given: 'a workspace row clicked while a different workspace was active',
        should: 'set the clicked workspace as the machine\'s active one',
        actual: machine.workspaces[machine.activeWorkspaceId].name,
        expected: 'Workspace 1',
      });
    });
  });

  test('the machine row\'s single "+" palette spawns a new terminal into a fresh, now-active workspace', async () => {
    render(<TerminalTab machineId="machine-1" />);

    await screen.findByText('Machine');
    await userEvent.click(screen.getByTitle('Add…'));
    await userEvent.click(await screen.findByRole('option', { name: 'Shell' }));

    await waitFor(() => {
      const machine = selectMachine('machine-1')(store())!;
      assert({
        given: 'the machine row\'s single "+" trigger used to spawn a new terminal on a fresh machine',
        should:
          'create exactly ONE workspace at machine scope — this used to expect TWO, because mounting fabricated a "Workspace 1" the user never asked for and the spawn then added a second beside it',
        actual: {
          count: Object.keys(machine.workspaces).length,
          activeScope: machine.workspaces[machine.activeWorkspaceId].scope,
        },
        expected: { count: 1, activeScope: { level: 'machine' } },
      });
    });
  });

  test('embedded renders only the workspace pane — no inner tree/sidebar', async () => {
    render(<TerminalTab machineId="machine-1" embedded />);

    const workspace = await screen.findByTestId('terminal-workspace');
    assert({
      given: 'the Terminal tab embedded in the Development surface',
      should: 'render just the active workspace\'s grid, omitting the redundant inner tree',
      actual: { workspace: workspace.textContent, tree: screen.queryByText('Machine') },
      expected: { workspace: 'workspace:machine-1', tree: null },
    });
  });
});
