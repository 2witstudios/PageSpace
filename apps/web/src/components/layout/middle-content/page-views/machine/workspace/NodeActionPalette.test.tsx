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

  test('the machine node offers New terminal + Add project, not Add branch', async () => {
    renderPalette(<NodeActionPalette machineId="m1" node={MACHINE_NODE} onAddProject={vi.fn()} onWorkspaceCreated={vi.fn()} />);
    await openPalette();

    assert({
      given: 'a machine node\'s palette, with onWorkspaceCreated wired in',
      should: 'offer New terminal and Add project, but not Add branch',
      actual: {
        newTerminal: screen.queryByRole('option', { name: 'New terminal' }) !== null,
        addProject: screen.queryByRole('option', { name: 'Add project' }) !== null,
        addBranch: screen.queryByRole('option', { name: 'Add branch' }) !== null,
      },
      expected: { newTerminal: true, addProject: true, addBranch: false },
    });
  });

  test('the project node offers New terminal + Add branch, not Add project', async () => {
    renderPalette(<NodeActionPalette machineId="m1" node={PROJECT_NODE} onAddBranch={vi.fn()} onWorkspaceCreated={vi.fn()} />);
    await openPalette();

    assert({
      given: 'a project node\'s palette, with onWorkspaceCreated wired in',
      should: 'offer New terminal and Add branch, but not Add project',
      actual: {
        newTerminal: screen.queryByRole('option', { name: 'New terminal' }) !== null,
        addBranch: screen.queryByRole('option', { name: 'Add branch' }) !== null,
        addProject: screen.queryByRole('option', { name: 'Add project' }) !== null,
      },
      expected: { newTerminal: true, addBranch: true, addProject: false },
    });
  });

  test('the branch node offers New terminal only', async () => {
    renderPalette(<NodeActionPalette machineId="m1" node={BRANCH_NODE} onWorkspaceCreated={vi.fn()} />);
    await openPalette();

    assert({
      given: 'a branch node\'s palette, with onWorkspaceCreated wired in',
      should: 'offer New terminal only — a branch has no structural add-child action',
      actual: {
        newTerminal: screen.queryByRole('option', { name: 'New terminal' }) !== null,
        addProject: screen.queryByRole('option', { name: 'Add project' }) !== null,
        addBranch: screen.queryByRole('option', { name: 'Add branch' }) !== null,
      },
      expected: { newTerminal: true, addProject: false, addBranch: false },
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

  test('"New terminal" creates a workspace at the node\'s scope, spawns the picked agent into it with the typed prompt, and reports the new workspace id', async () => {
    vi.mocked(post).mockResolvedValueOnce({
      agentTerminal: { name: 'claude-mocked', agentType: 'pagespace-cli', resumed: false },
    });
    const onWorkspaceCreated = vi.fn();
    renderPalette(<NodeActionPalette machineId="m1" node={PROJECT_NODE} onAddBranch={vi.fn()} onWorkspaceCreated={onWorkspaceCreated} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'New terminal' }));
    await user.type(await screen.findByLabelText('Starting prompt'), 'hello agent');
    await user.click(screen.getByRole('button', { name: 'Spawn agent' }));

    await waitFor(() => {
      const workspaceId = onWorkspaceCreated.mock.calls[0]?.[0];
      const machine = selectMachine('m1')(store());
      const workspace = workspaceId ? machine?.workspaces[workspaceId] : undefined;
      const pane = workspace?.columns[0]?.panes[0];
      assert({
        given: '"New terminal" submitted with a starting prompt, on a project node',
        should: 'create a workspace scoped to that project, bind the spawned agent into its first pane with the prompt pending, and report the workspace id',
        actual: {
          reported: workspaceId !== undefined,
          scope: workspace?.scope,
          paneAgentName: pane?.scope?.name,
          pendingPrompt: pane?.pendingPrompt,
        },
        expected: {
          reported: true,
          scope: { projectName: 'app' },
          paneAgentName: 'claude-mocked',
          pendingPrompt: 'hello agent',
        },
      });
    });
  });

  // Regression: submit() used to call onSpawned(workspaceId) unconditionally,
  // even if the user backed out (Escape/backdrop) while the addAgentTerminal
  // network call was still in flight. A late-resolving spawn would then still
  // report "success" to a caller no longer listening — in DevelopmentSidebar
  // that meant navigating the user to a workspace they explicitly cancelled.
  test('cancelling "New terminal" (Escape) while the spawn is in flight never reports success once it resolves', async () => {
    let resolveSpawn: (value: unknown) => void = () => {};
    vi.mocked(post).mockImplementationOnce(() => new Promise((resolve) => { resolveSpawn = resolve; }));
    const onWorkspaceCreated = vi.fn();
    renderPalette(<NodeActionPalette machineId="m1" node={MACHINE_NODE} onWorkspaceCreated={onWorkspaceCreated} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'New terminal' }));
    await user.click(screen.getByRole('button', { name: 'Spawn agent' }));

    // Still awaiting the network — back out before it resolves.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      assert({
        given: 'Escape pressed while a "New terminal" spawn is awaiting the network',
        should: 'close the palette immediately rather than wait for the in-flight spawn',
        actual: screen.queryByRole('dialog'),
        expected: null,
      });
    });

    resolveSpawn({ agentTerminal: { name: 'claude-late', agentType: 'claude', resumed: false } });
    // Let the now-resolved promise chain (addAgentTerminal -> cancelledRef
    // check -> removeAgentTerminal cleanup) finish draining.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert({
      given: 'the spawn resolving AFTER the user cancelled it',
      should: 'never call onWorkspaceCreated for a spawn the user backed out of',
      actual: onWorkspaceCreated.mock.calls.length,
      expected: 0,
    });
  });

  test('a "PageSpace Agent" palette spawn binds a chat-kind scope', async () => {
    vi.mocked(post).mockResolvedValueOnce({
      agentTerminal: { name: 'pagespace-mocked', agentType: 'pagespace', resumed: false },
    });
    const onWorkspaceCreated = vi.fn();
    renderPalette(<NodeActionPalette machineId="m1" node={BRANCH_NODE} onWorkspaceCreated={onWorkspaceCreated} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'New terminal' }));
    await user.click(await screen.findByLabelText('Agent type'));
    await user.click(await screen.findByRole('option', { name: 'PageSpace Agent' }));
    await user.click(screen.getByRole('button', { name: 'Spawn agent' }));

    await waitFor(() => {
      const workspaceId = onWorkspaceCreated.mock.calls[0]?.[0];
      const machine = selectMachine('m1')(store());
      const workspace = workspaceId ? machine?.workspaces[workspaceId] : undefined;
      const pane = workspace?.columns[0]?.panes[0];
      assert({
        given: 'the palette\'s "PageSpace Agent" choice, spawned on a branch node',
        should:
          'record kind "chat" on the bound pane scope — the pane grid renders MachinePaneChat from this tag, so a palette spawn that omitted it would open as a PTY',
        actual: { name: pane?.scope?.name, kind: pane?.scope?.kind },
        expected: { name: 'pagespace-mocked', kind: 'chat' },
      });
    });
  });

  test('"New terminal" offers shell, claude, codex, and the PageSpace Agent — not pagespace-cli — with shell first/default', async () => {
    renderPalette(<NodeActionPalette machineId="m1" node={MACHINE_NODE} onWorkspaceCreated={vi.fn()} />);

    const user = await openPalette();
    await user.click(await screen.findByRole('option', { name: 'New terminal' }));
    const agentTypeTrigger = await screen.findByLabelText('Agent type');
    const defaultSelected = agentTypeTrigger.textContent;

    await user.click(agentTypeTrigger);
    const optionTexts = (await screen.findAllByRole('option')).map((o) => o.textContent);

    assert({
      given: 'the "New terminal" agent-type picker, opened',
      should:
        'offer the shared PICKABLE_AGENT_TYPES — shell first/default, then claude, codex, and the chat agent labeled "PageSpace Agent" (never pagespace-cli); a palette-local hardcoded list is exactly what silently dropped pagespace from this surface',
      actual: { optionTexts, defaultSelected },
      expected: { optionTexts: ['shell', 'claude', 'codex', 'PageSpace Agent'], defaultSelected: 'shell' },
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
      should: 'show the action list (New terminal / Add branch), not the branch-name form left over from last time',
      actual: {
        actionList: screen.queryByRole('option', { name: 'Add branch' }) !== null,
        staleForm: screen.queryByPlaceholderText('Branch name') !== null,
      },
      expected: { actionList: true, staleForm: false },
    });
  });
});
