import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import type { ReactElement } from 'react';
import { assert } from '@/stores/__tests__/riteway';
import { useMachineWorkspaceStore, selectMachine, sessionWorkspaceId } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import WorkspaceLeaves, { WorkspaceNodeExtras } from './WorkspaceLeaves';
import type { MachineTreeNode } from './MachineTree';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify({ agentTerminals: [] }), { status: 200 })),
  post: vi.fn(),
  del: vi.fn(async () => new Response(null, { status: 204 })),
}));

import { toast } from 'sonner';
import { del, fetchWithAuth } from '@/lib/auth/auth-fetch';

const MACHINE_NODE: MachineTreeNode = { level: 'machine' };
const PROJECT_NODE: MachineTreeNode = { level: 'project', projectName: 'app' };

const store = () => useMachineWorkspaceStore.getState();

// A fresh SWR cache per render — without it, useAgentTerminals' SWR key
// (machineId+scope) is IDENTICAL across every test in this file, so a
// later test would silently see an earlier test's cached response instead
// of its own mocked fetchWithAuth override.
const renderLeaves = (ui: ReactElement) =>
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);

describe('WorkspaceLeaves', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMachineWorkspaceStore.setState({ machines: {} });
  });

  test('a machine this browser has never opened still shows its (auto-created) first workspace', async () => {
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

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
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={onSelectWorkspace} />);

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

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

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

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

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

    renderLeaves(<WorkspaceLeaves machineId="m1" node={PROJECT_NODE} onSelectWorkspace={vi.fn()} />);

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

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

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
    // A SECOND (empty) workspace, so removing the first one actually exercises
    // the removeWorkspace path — not the "last workspace" no-op path, which
    // has its own dedicated test below.
    store().createWorkspace('m1');

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const rows = await waitFor(() => screen.getAllByRole('button', { name: /^Workspace \d+$/ }));
    const row = (await screen.findByText('Workspace 1')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await screen.findByText(/stops its 1 running agent/);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      assert({
        given: 'a workspace holding one running pane, with a sibling workspace also present, remove confirmed',
        should: 'DELETE that agent_terminal server-side, then drop the local workspace entirely (its sibling survives)',
        actual: {
          deletedRunningAgent: vi.mocked(del).mock.calls.some(([url]) => String(url).includes('name=claude-a1b2c3')),
          remainingWorkspaces: Object.keys(selectMachine('m1')(store())!.workspaces).length,
        },
        expected: { deletedRunningAgent: true, remainingWorkspaces: rows.length - 1 },
      });
    });
  });

  // Regression (Codex P2): removeWorkspace is a no-op when it's the machine's
  // ONLY workspace (the store always keeps at least one) — a naive "kill the
  // agent, then removeWorkspace" leaves that no-op'd workspace with a pane
  // still bound to the agent name just killed: a zombie row/grid.
  test('removing the machine\'s ONLY workspace stops its agent but EMPTIES the workspace instead of leaving it bound to a dead agent', async () => {
    store().ensureMachine('m1');
    const workspaceId = selectMachine('m1')(store())!.activeWorkspaceId;
    const workspace = selectMachine('m1')(store())!.workspaces[workspaceId];
    store().bindPaneTerminal('m1', workspaceId, workspace.activePaneId, { name: 'claude-solo' });

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('Workspace 1')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      const machine = selectMachine('m1')(store())!;
      const remaining = machine.workspaces[workspaceId];
      // `pane.scope: null` is the CORRECT, expected outcome here — `??` would
      // wrongly swallow that legitimate null into a "missing" sentinel, so
      // presence and value are checked separately instead.
      const pane = remaining?.columns[0]?.panes[0];
      assert({
        given: 'a machine with exactly one workspace holding a running pane, remove confirmed',
        should: 'stop the agent server-side, then EMPTY the workspace locally rather than no-op and leave it bound to the killed agent',
        actual: {
          deletedRunningAgent: vi.mocked(del).mock.calls.some(([url]) => String(url).includes('name=claude-solo')),
          workspaceCount: Object.keys(machine.workspaces).length,
          stillOneWorkspace: remaining !== undefined,
          paneExists: pane !== undefined,
          paneScope: pane === undefined ? 'PANE_MISSING' : pane.scope,
        },
        expected: {
          deletedRunningAgent: true,
          workspaceCount: 1,
          stillOneWorkspace: true,
          paneExists: true,
          paneScope: null,
        },
      });
    });
  });

  // Regression (Codex P1): a session the server reports but that has no local
  // workspace yet (another browser, a cleared localStorage, an agent tool that
  // spawned it directly) must still be reachable and stoppable from the
  // sidebar — SessionLeaves was the only UI that ever listed those before this
  // redesign.
  test('a server-backed session with no local workspace is reachable — clicking adopts it into a real workspace', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      new Response(
        JSON.stringify({ agentTerminals: [{ name: 'orphan-1', agentType: 'claude', createdAt: '2026-01-01' }] }),
        { status: 200 },
      ),
    );
    const onSelectWorkspace = vi.fn();
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={onSelectWorkspace} />);

    const row = await screen.findByText('orphan-1');
    await userEvent.click(row);

    const expectedWorkspaceId = sessionWorkspaceId({ name: 'orphan-1' });
    await waitFor(() => {
      const machine = selectMachine('m1')(store())!;
      assert({
        given: 'a server-reported session with no matching local workspace, clicked',
        should: 'materialize (and activate) its own workspace, report that id to onSelectWorkspace, and turn into a normal (removable) row',
        actual: {
          reportedId: onSelectWorkspace.mock.calls[0]?.[0],
          nowActive: machine.activeWorkspaceId === expectedWorkspaceId,
          nowRemovable: screen.queryByTitle('Remove workspace orphan-1') !== null,
        },
        expected: { reportedId: expectedWorkspaceId, nowActive: true, nowRemovable: true },
      });
    });
  });

  // Codex review (PR #2053): dropping a legacy/unsupported row from the list
  // entirely would make it undiscoverable — DELETE still works by name, but
  // nothing in the UI would ever offer that name again. Instead it stays
  // listed and the client itself derives launchability from `agentType` via
  // `isAgentRuntimeType` (no server-sent flag), rendering remove-only (never
  // adopt) so it stays cleanable without ever being treated as an openable
  // session.
  test('a listed session whose agentType is not a recognized AgentRuntimeType cannot be adopted, only removed', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      new Response(
        JSON.stringify({
          agentTerminals: [{ name: 'legacy-cli', agentType: 'pagespace-cli', createdAt: '2026-01-01' }],
        }),
        { status: 200 },
      ),
    );
    const onSelectWorkspace = vi.fn();
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={onSelectWorkspace} />);

    const row = (await screen.findByText('legacy-cli')).closest('.group') as HTMLElement;
    await userEvent.click(screen.getByText('legacy-cli'));

    assert({
      given: 'a legacy row whose agentType is no longer a recognized AgentRuntimeType',
      should: 'render it without an adopt affordance (clicking its name does nothing) but WITH a remove button',
      actual: {
        adoptedAnything: onSelectWorkspace.mock.calls.length,
        hasRemoveButton: within(row).queryByRole('button', { name: /Remove unsupported session legacy-cli/ }) !== null,
      },
      expected: { adoptedAnything: 0, hasRemoveButton: true },
    });
  });

  test('removing an unlaunchable session calls DELETE by name, same as any other agent terminal', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      new Response(
        JSON.stringify({
          agentTerminals: [{ name: 'legacy-cli', agentType: 'pagespace-cli', createdAt: '2026-01-01' }],
        }),
        { status: 200 },
      ),
    );
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('legacy-cli')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove unsupported session legacy-cli/ }));

    await waitFor(() => {
      assert({
        given: 'the remove button on an unlaunchable session',
        should: 'DELETE it by name server-side, exactly like a normal running agent',
        actual: vi.mocked(del).mock.calls.some(([url]) => String(url).includes('name=legacy-cli')),
        expected: true,
      });
    });
  });

  // Self-review finding (PR #2053): unlike removing a live workspace (routed
  // through ConfirmRemoveDialog, which reports a thrown error via toast), a
  // fire-and-forget remove call with nothing observing the rejection would
  // silently no-op on failure — the row stays, but the user gets no signal why.
  test('a failed removal of an unlaunchable session is reported via toast, not swallowed silently', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      new Response(
        JSON.stringify({
          agentTerminals: [{ name: 'legacy-cli', agentType: 'pagespace-cli', createdAt: '2026-01-01' }],
        }),
        { status: 200 },
      ),
    );
    vi.mocked(del).mockRejectedValueOnce(new Error('Failed to remove'));
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('legacy-cli')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove unsupported session legacy-cli/ }));

    await waitFor(() => {
      assert({
        given: 'a DELETE that rejects for an unlaunchable session\'s remove button',
        should: 'surface the failure via toast.error rather than swallowing it',
        actual: vi.mocked(toast.error).mock.calls.length,
        expected: 1,
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
    renderLeaves(<WorkspaceNodeExtras machineId="m1" node={MACHINE_NODE} onWorkspaceCreated={vi.fn()} />);

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

    renderLeaves(<WorkspaceNodeExtras machineId="m1" node={MACHINE_NODE} onWorkspaceCreated={vi.fn()} />);

    assert({
      given: 'one running pane at machine scope',
      should: 'show a "1 running" badge',
      actual: screen.getByText('1 running').textContent,
      expected: '1 running',
    });
  });

  test('the new-workspace button creates a workspace at the node\'s scope and reports its id', async () => {
    const onWorkspaceCreated = vi.fn();
    renderLeaves(<WorkspaceNodeExtras machineId="m1" node={PROJECT_NODE} onWorkspaceCreated={onWorkspaceCreated} />);

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
