import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import type { ReactElement } from 'react';
import { assert } from '@/stores/__tests__/riteway';
import { useMachineWorkspaceStore, selectMachine } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import NodeActionPalette from './NodeActionPalette';
import type { MachineTreeNode } from './MachineTree';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// `createWorkspace`/`bindPaneTerminal` (useSyncedWorkspaceActions, #2048) push
// the resulting workspace to the server via these — fire-and-forget from this
// component's point of view, but each must resolve rather than return
// undefined, or `pushNewWorkspace`'s `.then()` throws synchronously.
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify({ agentTerminals: [] }), { status: 200 })),
  post: vi.fn(async () => ({})),
  del: vi.fn(async () => new Response(null, { status: 204 })),
}));

vi.mock('@/hooks/useGithubRepos', () => ({
  useGithubRepos: () => ({ repos: [], connected: true, isLoading: false, error: undefined, mutate: vi.fn() }),
}));

vi.mock('@/hooks/useIntegrations', () => ({
  useProviders: () => ({ providers: [] }),
}));

import { toast } from 'sonner';
import { post } from '@/lib/auth/auth-fetch';

const MACHINE_NODE: MachineTreeNode = { level: 'machine' };
const PROJECT_NODE: MachineTreeNode = { level: 'project', projectName: 'app' };
const BRANCH_NODE: MachineTreeNode = { level: 'branch', projectName: 'app', branchName: 'main' };

const store = () => useMachineWorkspaceStore.getState();

const renderPalette = (ui: ReactElement) =>
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);

const openPalette = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByTitle('Add…'));
  return user;
};

describe('NodeActionPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useMachineWorkspaceStore.setState({ machines: {} });
  });

  test('a single "+" trigger opens the palette', async () => {
    renderPalette(<NodeActionPalette machineId="m1" node={MACHINE_NODE} onAddProject={vi.fn()} />);

    assert({
      given: 'the row not yet interacted with',
      should: 'show exactly one "+" trigger and no open dialog',
      actual: { triggers: screen.getAllByTitle('Add…').length, dialog: screen.queryByRole('dialog') },
      expected: { triggers: 1, dialog: null },
    });

    await openPalette();
    assert({
      given: 'the "+" trigger clicked',
      should: 'open the action palette',
      actual: screen.queryByRole('dialog') !== null,
      expected: true,
    });
  });

  test('the machine node offers Agent + Shell + Add project, not Add branch', async () => {
    renderPalette(<NodeActionPalette machineId="m1" node={MACHINE_NODE} onAddProject={vi.fn()} onWorkspaceCreated={vi.fn()} />);
    await openPalette();

    assert({
      given: 'a machine node\'s palette, with onWorkspaceCreated wired in',
      should: 'offer the instant spawns plus Add project, but not Add branch',
      actual: {
        agent: screen.queryByRole('option', { name: 'Agent' }) !== null,
        shell: screen.queryByRole('option', { name: 'Shell' }) !== null,
        addProject: screen.queryByRole('option', { name: 'Add project' }) !== null,
        addBranch: screen.queryByRole('option', { name: 'Add branch' }) !== null,
      },
      expected: { agent: true, shell: true, addProject: true, addBranch: false },
    });
  });

  test('the project node offers Agent + Shell + Add branch, not Add project', async () => {
    renderPalette(<NodeActionPalette machineId="m1" node={PROJECT_NODE} onAddBranch={vi.fn()} onWorkspaceCreated={vi.fn()} />);
    await openPalette();

    assert({
      given: 'a project node\'s palette, with onWorkspaceCreated wired in',
      should: 'offer the instant spawns plus Add branch, but not Add project',
      actual: {
        agent: screen.queryByRole('option', { name: 'Agent' }) !== null,
        shell: screen.queryByRole('option', { name: 'Shell' }) !== null,
        addBranch: screen.queryByRole('option', { name: 'Add branch' }) !== null,
        addProject: screen.queryByRole('option', { name: 'Add project' }) !== null,
      },
      expected: { agent: true, shell: true, addBranch: true, addProject: false },
    });
  });

  test('the branch node offers Agent + Shell only', async () => {
    renderPalette(<NodeActionPalette machineId="m1" node={BRANCH_NODE} onWorkspaceCreated={vi.fn()} />);
    await openPalette();

    assert({
      given: 'a branch node\'s palette, with onWorkspaceCreated wired in',
      should: 'offer the instant spawns only — a branch has no structural add-child action',
      actual: {
        agent: screen.queryByRole('option', { name: 'Agent' }) !== null,
        shell: screen.queryByRole('option', { name: 'Shell' }) !== null,
        addProject: screen.queryByRole('option', { name: 'Add project' }) !== null,
        addBranch: screen.queryByRole('option', { name: 'Add branch' }) !== null,
      },
      expected: { agent: true, shell: true, addProject: false, addBranch: false },
    });
  });

  test('a bare tree (no onWorkspaceCreated) renders no "+" at all for a branch node — it has no other action', () => {
    renderPalette(<NodeActionPalette machineId="m1" node={BRANCH_NODE} />);

    assert({
      given: 'a branch node with no onAddProject/onAddBranch/onWorkspaceCreated (the Diff/Files-tab shape)',
      should: 'render nothing — a branch offers no structural add-child action and no workspace concept',
      actual: screen.queryByTitle('Add…'),
      expected: null,
    });
  });

  test('the spawn options derive from the registry: exactly Agent then Shell', async () => {
    renderPalette(<NodeActionPalette machineId="m1" node={BRANCH_NODE} onWorkspaceCreated={vi.fn()} />);
    await openPalette();

    const optionTexts = (await screen.findAllByRole('option')).map((o) => o.textContent);
    assert({
      given: 'the palette\'s spawn group, on a node with no structural actions',
      should:
        'list exactly the PICKABLE_AGENT_TYPES in registry order — Agent (pagespace) first, then Shell; a palette-local hardcoded list is exactly what silently dropped pagespace from this surface once',
      actual: optionTexts,
      expected: ['Agent', 'Shell'],
    });
  });

  test('clicking Shell closes the palette immediately and spawns into a fresh workspace at the node\'s scope', async () => {
    vi.mocked(post).mockResolvedValueOnce({
      agentTerminal: { name: 'shell-mocked', agentType: 'shell', resumed: false },
    });
    const onWorkspaceCreated = vi.fn();
    renderPalette(<NodeActionPalette machineId="m1" node={PROJECT_NODE} onAddBranch={vi.fn()} onWorkspaceCreated={onWorkspaceCreated} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'Shell' }));

    // The click is the commitment: no second phase, no form — the palette is
    // gone before the network resolves.
    await waitFor(() => {
      assert({
        given: 'Shell clicked in the palette',
        should: 'close the palette immediately (instant spawn, no form phase)',
        actual: screen.queryByRole('dialog'),
        expected: null,
      });
    });

    await waitFor(() => {
      const workspaceId = onWorkspaceCreated.mock.calls[0]?.[0];
      const machine = selectMachine('m1')(store());
      const workspace = workspaceId ? machine?.workspaces[workspaceId] : undefined;
      const pane = workspace?.columns[0]?.panes[0];
      assert({
        given: 'the spawn resolving, on a project node',
        should:
          'create a workspace scoped to that project, bind the spawned shell into its first pane with NO pending prompt (the prompt is typed in the pane), and report the workspace id',
        actual: {
          reported: workspaceId !== undefined,
          scope: workspace?.scope,
          paneAgentName: pane?.scope?.name,
          kind: pane?.scope?.kind,
          pendingPrompt: pane?.pendingPrompt,
        },
        expected: {
          reported: true,
          scope: { projectName: 'app' },
          paneAgentName: 'shell-mocked',
          kind: undefined,
          pendingPrompt: undefined,
        },
      });
    });
  });

  test('clicking Agent binds a chat-kind scope', async () => {
    vi.mocked(post).mockResolvedValueOnce({
      agentTerminal: { name: 'pagespace-mocked', agentType: 'pagespace', resumed: false },
    });
    const onWorkspaceCreated = vi.fn();
    renderPalette(<NodeActionPalette machineId="m1" node={BRANCH_NODE} onWorkspaceCreated={onWorkspaceCreated} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'Agent' }));

    await waitFor(() => {
      const workspaceId = onWorkspaceCreated.mock.calls[0]?.[0];
      const machine = selectMachine('m1')(store());
      const workspace = workspaceId ? machine?.workspaces[workspaceId] : undefined;
      const pane = workspace?.columns[0]?.panes[0];
      assert({
        given: 'the palette\'s Agent choice, spawned on a branch node',
        should:
          'record kind "chat" on the bound pane scope — the pane grid renders MachinePaneChat from this tag, so a palette spawn that omitted it would open as a PTY',
        actual: { name: pane?.scope?.name, kind: pane?.scope?.kind },
        expected: { name: 'pagespace-mocked', kind: 'chat' },
      });
    });
  });

  test('a spawn that fails after the palette closed toasts the error and never navigates', async () => {
    let rejectSpawn: (reason: Error) => void = () => {};
    vi.mocked(post).mockImplementationOnce(() => new Promise((resolve, reject) => { rejectSpawn = reject; }));
    const onWorkspaceCreated = vi.fn();
    renderPalette(<NodeActionPalette machineId="m1" node={MACHINE_NODE} onWorkspaceCreated={onWorkspaceCreated} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'Agent' }));

    // Palette already closed, spawn still in flight.
    await waitFor(() => {
      assert({
        given: 'Agent clicked, spawn in flight',
        should: 'have closed the palette already',
        actual: screen.queryByRole('dialog'),
        expected: null,
      });
    });

    rejectSpawn(new Error('code_execution_disabled'));
    await waitFor(() => {
      assert({
        given: 'the spawn rejecting after the palette closed',
        should: 'surface the error via toast and never call onWorkspaceCreated',
        actual: {
          toasts: vi.mocked(toast.error).mock.calls.length,
          navigations: onWorkspaceCreated.mock.calls.length,
        },
        expected: { toasts: 1, navigations: 0 },
      });
    });
  });

  test('"Add project" submits the trimmed name (server-side normalizes it; the field only previews that)', async () => {
    const onAddProject = vi.fn().mockResolvedValue(undefined);
    renderPalette(<NodeActionPalette machineId="m1" node={MACHINE_NODE} onAddProject={onAddProject} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'Add project' }));
    await user.click(await screen.findByRole('button', { name: 'Enter a repo URL manually' }));
    await user.type(screen.getByPlaceholderText('Project name'), 'My Repo');
    await user.type(screen.getByPlaceholderText(/Repo URL/), 'https://github.com/org/my-repo.git');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add project' }));

    await waitFor(() => {
      assert({
        given: '"Add project" submitted with an un-normalized name',
        should: 'call onAddProject with the raw (trimmed) name — normalization is server-side, this only PREVIEWS it',
        actual: onAddProject.mock.calls[0],
        expected: ['My Repo', 'https://github.com/org/my-repo.git'],
      });
    });
  });

  test('"Add branch" submits the trimmed branch name', async () => {
    const onAddBranch = vi.fn().mockResolvedValue(undefined);
    renderPalette(<NodeActionPalette machineId="m1" node={PROJECT_NODE} onAddBranch={onAddBranch} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'Add branch' }));
    await user.type(screen.getByPlaceholderText('Branch name'), '  feat/y  ');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add branch' }));

    await waitFor(() => {
      assert({
        given: '"Add branch" submitted with surrounding whitespace',
        should: 'call onAddBranch with the trimmed name',
        actual: onAddBranch.mock.calls[0]?.[0],
        expected: 'feat/y',
      });
    });
  });

  // Regression (Codex P2): a successful submit closes the palette via `close()`,
  // which sets `open` false directly rather than through Radix's onOpenChange —
  // so the phase-reset that onOpenChange triggers on an Escape/backdrop close
  // must ALSO happen on this path, or reopening the "+" drops the user straight
  // back into the just-completed form instead of the action list.
  test('reopening the "+" after a successful "Add branch" shows the action list again, not the same form', async () => {
    const onAddBranch = vi.fn().mockResolvedValue(undefined);
    renderPalette(<NodeActionPalette machineId="m1" node={PROJECT_NODE} onAddBranch={onAddBranch} onWorkspaceCreated={vi.fn()} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'Add branch' }));
    await user.type(screen.getByPlaceholderText('Branch name'), 'feat/z');
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add branch' }));

    await waitFor(() => {
      assert({
        given: 'a successful "Add branch" submit',
        should: 'close the palette dialog',
        actual: screen.queryByRole('dialog'),
        expected: null,
      });
    });
    await user.click(screen.getByTitle('Add…'));

    assert({
      given: 'the palette reopened right after a successful "Add branch" submit',
      should: 'show the action list (Agent / Shell / Add branch), not the branch-name form left over from last time',
      actual: {
        actionList: screen.queryByRole('option', { name: 'Add branch' }) !== null,
        staleForm: screen.queryByPlaceholderText('Branch name') !== null,
      },
      expected: { actionList: true, staleForm: false },
    });
  });
});
