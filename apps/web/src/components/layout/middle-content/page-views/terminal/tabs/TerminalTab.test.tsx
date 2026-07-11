import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  useMachineProjects: (machineId: string | null) => ({
    projects: machineId ? [{ name: 'my-repo', repoUrl: 'https://github.com/org/my-repo.git', path: '/repo', createdAt: '2026-01-01' }] : [],
    isLoading: false,
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}));
vi.mock('@/hooks/useMachineBranches', () => ({
  useMachineBranches: (machineId: string | null) => ({
    branches: machineId ? [{ branchName: 'main', createdAt: '2026-01-01' }] : [],
    isLoading: false,
    addBranch: vi.fn(),
    removeBranch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useGithubRepos', () => ({
  useGithubRepos: () => ({ repos: [], connected: true, isLoading: false, error: undefined, mutate: vi.fn() }),
}));
vi.mock('@/hooks/useIntegrations', () => ({ useProviders: () => ({ providers: [] }) }));

const addAgentTerminal = vi.fn();
const removeAgentTerminal = vi.fn();
// Scope-aware: each of the three universal scopes (machine / project / branch)
// returns a distinctly-named session leaf, so a test can click the leaf at a
// given scope and assert the exact OpenTerminalScope threaded to openTerminal.
vi.mock('@/hooks/useAgentTerminals', () => ({
  useAgentTerminals: (machineId: string | null, projectName?: string | null, branchName?: string | null) => {
    let name: string | null = null;
    if (machineId) {
      if (branchName) name = 'branch-sesh';
      else if (projectName) name = 'project-sesh';
      else name = 'machine-sesh';
    }
    return {
      agentTerminals: name ? [{ name, agentType: 'claude', createdAt: '2026-01-01' }] : [],
      isLoading: false,
      error: undefined,
      mutate: vi.fn(),
      addAgentTerminal,
      removeAgentTerminal,
    };
  },
}));

const openTerminal = vi.fn();
vi.mock('@/stores/terminal-workspace/useTerminalWorkspaceStore', () => ({
  useTerminalWorkspaceStore: (selector: (s: { openTerminal: typeof openTerminal }) => unknown) =>
    selector({ openTerminal }),
}));

import TerminalTab from './TerminalTab';

/** The row's chevron and its label live in separate buttons (see MachineTree's
 * TreeRow) — find the row by its label text, then click just its chevron. */
const expandRowFor = async (labelText: string) => {
  const label = await waitFor(() => screen.getByText(labelText));
  const row = label.closest('.group') as HTMLElement;
  await userEvent.click(within(row).getByTestId('expand-chevron'));
};

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

  test('clicking a machine-root session opens it with machine scope (no project/branch)', async () => {
    render(<TerminalTab machineId="machine-1" />);

    // The machine root is expanded by default, so its session leaf is visible.
    const session = await waitFor(() => screen.getByText('machine-sesh'));
    await userEvent.click(session);

    assert({
      given: 'a session leaf under the machine root clicked',
      should: 'call openTerminal(machineId, machine-scoped scope) — not prop-thread through a parent',
      actual: openTerminal.mock.calls[0],
      expected: ['machine-1', { projectName: undefined, branchName: undefined, name: 'machine-sesh' }],
    });
  });

  test('clicking a project-scoped session threads projectName (branch still undefined)', async () => {
    render(<TerminalTab machineId="machine-1" />);

    await expandRowFor('my-repo');
    const session = await waitFor(() => screen.getByText('project-sesh'));
    await userEvent.click(session);

    assert({
      given: 'a session leaf under an expanded project node clicked',
      should: 'open with projectName set and branchName undefined — scopeFor derives the project scope',
      actual: openTerminal.mock.calls[0],
      expected: ['machine-1', { projectName: 'my-repo', branchName: undefined, name: 'project-sesh' }],
    });
  });

  test('clicking a branch-scoped session threads both projectName and branchName', async () => {
    render(<TerminalTab machineId="machine-1" />);

    await expandRowFor('my-repo');
    await expandRowFor('main');
    const session = await waitFor(() => screen.getByText('branch-sesh'));
    await userEvent.click(session);

    assert({
      given: 'a session leaf under an expanded branch node clicked',
      should: 'open with both projectName and branchName set — scopeFor derives the full branch scope',
      actual: openTerminal.mock.calls[0],
      expected: ['machine-1', { projectName: 'my-repo', branchName: 'main', name: 'branch-sesh' }],
    });
  });
});
