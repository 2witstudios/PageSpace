import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import { useMachineWorkspaceStore, selectMachine } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import WorkspaceLeaves, { WorkspaceNodeExtras } from './WorkspaceLeaves';
import type { MachineTreeNode } from './MachineTree';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify({ agentTerminals: [] }), { status: 200 })),
  post: vi.fn(),
  del: vi.fn(async () => new Response(null, { status: 204 })),
}));

import { del } from '@/lib/auth/auth-fetch';

const MACHINE_NODE: MachineTreeNode = { level: 'machine' };
const PROJECT_NODE: MachineTreeNode = { level: 'project', projectName: 'app' };

const store = () => useMachineWorkspaceStore.getState();

describe('WorkspaceLeaves', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMachineWorkspaceStore.setState({ machines: {} });
  });

  test('a machine this browser has never opened still shows its (auto-created) first workspace', async () => {
    render(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = await screen.findByText('Workspace 1');
    assert({
      given: 'a machine with no prior local workspace state',
      should: 'idempotent-repair a first workspace so the node is never permanently empty',
      actual: row.textContent,
      expected: 'Workspace 1',
    });
  });

  test('clicking a workspace row reports its id, not its name', async () => {
    const onSelectWorkspace = vi.fn();
    render(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={onSelectWorkspace} />);

    const row = await screen.findByText('Workspace 1');
    await userEvent.click(row);

    const workspaceId = Object.keys(selectMachine('m1')(store())!.workspaces)[0];
    assert({
      given: 'a workspace row clicked',
      should: 'call onSelectWorkspace with the workspace id',
      actual: onSelectWorkspace.mock.calls[0]?.[0],
      expected: workspaceId,
    });
  });

  test('the active workspace is marked aria-current; an inactive sibling is not', async () => {
    store().ensureMachine('m1');
    const first = selectMachine('m1')(store())!.activeWorkspaceId;
    const second = store().createWorkspace('m1');

    render(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const rows = await waitFor(() => screen.getAllByRole('button', { name: /^Workspace \d+$/ }));
    const current = rows.map((row) => row.getAttribute('aria-current'));

    assert({
      given: 'two workspaces, the second created (and so made active) last',
      should: 'mark only the active one aria-current',
      actual: { activeIsSecond: second !== first, currentCount: current.filter((c) => c === 'true').length },
      expected: { activeIsSecond: true, currentCount: 1 },
    });
  });

  test('a session bound into an existing workspace via split-and-pick is not listed as its own row', async () => {
    store().ensureMachine('m1');
    const workspace = selectMachine('m1')(store())!.workspaces[selectMachine('m1')(store())!.activeWorkspaceId];
    store().splitRight('m1', workspace.id, workspace.activePaneId);
    const withPane = selectMachine('m1')(store())!.workspaces[workspace.id];
    const newPaneId = withPane.columns[1].panes[0].id;
    store().bindPaneTerminal('m1', workspace.id, newPaneId, { name: 'claude-a1b2c3' });

    render(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    await screen.findByText('Workspace 1');
    assert({
      given: 'an agent spawned into a split pane of an existing workspace (not its own workspace)',
      should: 'render only the owning workspace as a row — the child pane is not a separate row',
      actual: {
        rows: screen.getAllByRole('button', { name: /^Workspace \d+$/ }).length,
        childRowRendered: screen.queryByText('claude-a1b2c3') !== null,
      },
      expected: { rows: 1, childRowRendered: false },
    });
  });

  test('workspaces are filtered to the node\'s own scope', async () => {
    store().ensureMachine('m1'); // machine-scope "Workspace 1"
    store().createWorkspace('m1', { projectName: 'app' }); // project-scope "Workspace 2"

    render(<WorkspaceLeaves machineId="m1" node={PROJECT_NODE} onSelectWorkspace={vi.fn()} />);

    const rows = await waitFor(() => screen.getAllByRole('button', { name: /^Workspace \d+$/ }));
    assert({
      given: 'one machine-scope and one project-scope workspace, rendered at the PROJECT node',
      should: 'show only the project-scoped workspace',
      actual: rows.map((row) => row.textContent),
      expected: ['Workspace 2'],
    });
  });

  test('removing an EMPTY workspace calls the store action after confirming', async () => {
    store().ensureMachine('m1');
    store().createWorkspace('m1');

    render(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const rows = await waitFor(() => screen.getAllByRole('button', { name: /^Workspace \d+$/ }));
    const row = rows[0].closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      assert({
        given: 'an empty workspace remove confirmed',
        should: 'drop it from the machine\'s workspace set',
        actual: Object.keys(selectMachine('m1')(store())!.workspaces).length,
        expected: 1,
      });
    });
  });

  // Regression (Codex P1): SessionLeaves (deleted by this redesign) was the
  // only UI caller that ever stopped a specific agent_terminal server-side.
  // Removing a workspace must not just hide a still-running agent locally —
  // it has to actually stop it, or the sidebar leaves no way back to a
  // running (and billing) Sprite.
  test('removing a workspace WITH a running pane stops that agent server-side before dropping the workspace', async () => {
    store().ensureMachine('m1');
    const workspace = selectMachine('m1')(store())!.workspaces[selectMachine('m1')(store())!.activeWorkspaceId];
    store().bindPaneTerminal('m1', workspace.id, workspace.activePaneId, { name: 'claude-a1b2c3' });

    render(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const rows = await waitFor(() => screen.getAllByRole('button', { name: /^Workspace \d+$/ }));
    const row = rows[0].closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await screen.findByText(/stops its 1 running agent/);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      assert({
        given: 'a workspace holding one running pane, remove confirmed',
        should: 'DELETE that agent_terminal server-side, then drop the local workspace',
        actual: {
          deletedRunningAgent: vi.mocked(del).mock.calls.some(([url]) => String(url).includes('name=claude-a1b2c3')),
          workspaceCount: Object.keys(selectMachine('m1')(store())!.workspaces).length,
        },
        expected: { deletedRunningAgent: true, workspaceCount: 1 },
      });
    });
  });
});

describe('WorkspaceNodeExtras', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMachineWorkspaceStore.setState({ machines: {} });
  });

  test('shows no running-count badge when nothing is running', () => {
    render(<WorkspaceNodeExtras machineId="m1" node={MACHINE_NODE} onWorkspaceCreated={vi.fn()} />);

    assert({
      given: 'a machine with no running agents',
      should: 'render no running-count badge',
      actual: screen.queryByText(/running/i),
      expected: null,
    });
  });

  test('shows a running-count badge scoped to the node', () => {
    store().ensureMachine('m1');
    const workspace = selectMachine('m1')(store())!.workspaces[selectMachine('m1')(store())!.activeWorkspaceId];
    store().bindPaneTerminal('m1', workspace.id, workspace.activePaneId, { name: 'claude-a1b2c3' });

    render(<WorkspaceNodeExtras machineId="m1" node={MACHINE_NODE} onWorkspaceCreated={vi.fn()} />);

    assert({
      given: 'one running pane at machine scope',
      should: 'show a "1 running" badge',
      actual: screen.getByText('1 running').textContent,
      expected: '1 running',
    });
  });

  test('the new-workspace button creates a workspace at the node\'s scope and reports its id', async () => {
    const onWorkspaceCreated = vi.fn();
    render(<WorkspaceNodeExtras machineId="m1" node={PROJECT_NODE} onWorkspaceCreated={onWorkspaceCreated} />);

    await userEvent.click(screen.getByRole('button', { name: 'New workspace' }));

    const machine = selectMachine('m1')(store())!;
    const created = machine.workspaces[machine.activeWorkspaceId];
    assert({
      given: 'the new-workspace button clicked on a project node',
      should: 'create a workspace scoped to that project and report its id',
      actual: { scope: created.scope, reportedId: onWorkspaceCreated.mock.calls[0]?.[0] },
      expected: { scope: { projectName: 'app' }, reportedId: created.id },
    });
  });
});
