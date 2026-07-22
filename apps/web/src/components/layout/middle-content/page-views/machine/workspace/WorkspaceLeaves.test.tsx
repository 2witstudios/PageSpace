import { describe, test, beforeEach, vi, expect } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import type { ReactElement } from 'react';
import { assert } from '@/stores/__tests__/riteway';
import {
  useMachineWorkspaceStore,
  selectMachine,
  MACHINE_NODE_SCOPE,
  sessionWorkspaceId,
  workspacesOf,
  type MachineNodeScope,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';
import WorkspaceLeaves, { WorkspaceNodeExtras } from './WorkspaceLeaves';
import type { MachineTreeNode } from './MachineTree';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify({ agentTerminals: [] }), { status: 200 })),
  // These three back `useSyncedWorkspaceActions`' server pushes (#2048) — the
  // sidebar's own actions (create/rename/remove/adopt) all fire one of these
  // fire-and-forget, so each must resolve rather than return undefined.
  post: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  del: vi.fn(async () => new Response(null, { status: 204 })),
}));

import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

// `pushWorkspaceUpdate` (useMachineWorkspaceSync) PATCHes via `fetchWithAuth`
// directly rather than the `patch()` helper, to read the real HTTP status
// code — see that file's doc comment. These tests assert on the PATCH calls
// made through the shared `fetchWithAuth` mock.
const patchCallsTo = (url: string) =>
  vi.mocked(fetchWithAuth).mock.calls.filter(
    ([calledUrl, options]) => calledUrl === url && (options as RequestInit | undefined)?.method === 'PATCH',
  );

// Every session removal — `killAgentTerminal` AND the hook's
// `removeAgentTerminal` — DELETEs via `fetchWithAuth` directly so it can read
// the real HTTP status (a 404 is the success state), wrapped in an optimistic
// SWR mutation that drops the row synchronously and rolls it back on genuine
// failure. All removal calls therefore show up here, not on the `del` mock.
const killCalls = () =>
  vi.mocked(fetchWithAuth).mock.calls.filter(
    ([, options]) => (options as RequestInit | undefined)?.method === 'DELETE',
  );

const MACHINE_NODE: MachineTreeNode = { level: 'machine' };
const PROJECT_NODE: MachineTreeNode = { level: 'project', projectName: 'app' };
const BRANCH_NODE: MachineTreeNode = { level: 'branch', projectName: 'app', branchName: 'main' };

const store = () => useMachineWorkspaceStore.getState();

/** A machine with one workspace at `scope`. Rendering alone no longer produces
 * one: `ensureMachine` creates the machine's entry and nothing else, because a
 * machine with no terminals is a legal state rather than a blank view to repair. */
const seedMachine = (machineId: string, scope: MachineNodeScope = MACHINE_NODE_SCOPE) => {
  store().ensureMachine(machineId);
  return store().createWorkspace(machineId, scope);
};

// A fresh SWR cache per render — without it, useAgentTerminals' SWR key
// (machineId+scope) is IDENTICAL across every test in this file, so a
// later test would silently see an earlier test's cached response instead
// of its own mocked fetchWithAuth override.
const renderLeaves = (ui: ReactElement) =>
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);

describe('WorkspaceLeaves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useMachineWorkspaceStore.setState({ machines: {} });
  });

  test('a machine this browser has never opened shows no workspace rows', async () => {
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    await waitFor(() => expect(store().machines['m1']).toBeDefined());
    assert({
      given: 'a machine with no prior local workspace state',
      should:
        'list nothing — fabricating a first workspace here invented rows for machines the user never opened, and put a removed row straight back',
      actual: screen.queryByText('Workspace 1'),
      expected: null,
    });
  });

  test('removing the only workspace, then creating a new one, leaves exactly ONE row', async () => {
    // THE REPORTED BUG. The floor made removeWorkspace a no-op on the last
    // workspace, so the sidebar emptied its panes instead and the row survived;
    // `+ New terminal` then added a second row beside the zombie.
    seedMachine('m1');
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('Workspace 1')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(workspacesOf(selectMachine('m1')(store())).length).toBe(0));

    act(() => {
      store().createWorkspace('m1');
    });

    assert({
      given: 'the machine\'s only workspace removed, then a new terminal opened',
      should: 'show exactly one row — not the un-removable zombie plus a new one',
      actual: workspacesOf(selectMachine('m1')(store())).length,
      expected: 1,
    });
  });

  test('clicking a workspace row reports its id, not its name', async () => {
    seedMachine('m1');
    const onSelectWorkspace = vi.fn();
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={onSelectWorkspace} />);

    const row = await screen.findByText('Workspace 1');
    await userEvent.click(row);

    const workspaceId = Object.keys(selectMachine('m1')(store())!.workspaces)[0];
    await waitFor(() => {
      assert({
        given: 'a workspace row clicked',
        should: 'call onSelectWorkspace with the workspace id',
        actual: onSelectWorkspace.mock.calls[0]?.[0],
        expected: workspaceId,
      });
    });
  });

  // Regression: a browser fires BOTH `click` events of a double-click before
  // `dblclick` — a bare onClick would call onSelectWorkspace on the way to
  // renaming, which in the real caller (DevelopmentSidebar) navigates. The
  // first click's onSelectWorkspace must be deferred and cancelled by the
  // second click that starts the rename.
  test('double-clicking a workspace name to rename it does NOT also call onSelectWorkspace', async () => {
    seedMachine('m1');
    const onSelectWorkspace = vi.fn();
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={onSelectWorkspace} />);

    const row = await screen.findByText('Workspace 1');
    await userEvent.dblClick(row);

    expect(screen.getByLabelText('Rename workspace Workspace 1')).toBeDefined();
    // Give the (now-cancelled) deferred single-click timer a chance to fire
    // if the cancellation didn't actually work.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  test('the active workspace is marked aria-current; an inactive sibling is not', async () => {
    seedMachine('m1');
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
    seedMachine('m1');
    const workspace = selectMachine('m1')(store())!.workspaces[selectMachine('m1')(store())!.activeWorkspaceId];
    store().splitRight('m1', workspace.id, workspace.activePaneId);
    const withPane = selectMachine('m1')(store())!.workspaces[workspace.id];
    const newPaneId = withPane.columns[1].panes[0].id;
    store().bindPaneTerminal('m1', workspace.id, newPaneId, { name: 'shell-a1b2c3' });

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    await screen.findByText('Workspace 1');
    assert({
      given: 'an agent spawned into a split pane of an existing workspace (not its own workspace)',
      should: 'render only the owning workspace as a row — the child pane is not a separate row',
      actual: {
        rows: screen.getAllByRole('button', { name: /^Workspace \d+$/ }).length,
        childRowRendered: screen.queryByText('shell-a1b2c3') !== null,
      },
      expected: { rows: 1, childRowRendered: false },
    });
  });

  test('workspaces are filtered to the node\'s own scope', async () => {
    seedMachine('m1'); // machine-scope "Workspace 1"
    store().createWorkspace('m1', { level: 'project', projectName: 'app' }); // project-scope "Workspace 2"

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
    seedMachine('m1');
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
    seedMachine('m1');
    const workspace = selectMachine('m1')(store())!.workspaces[selectMachine('m1')(store())!.activeWorkspaceId];
    store().bindPaneTerminal('m1', workspace.id, workspace.activePaneId, { name: 'shell-a1b2c3' });
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
          deletedRunningAgent: killCalls().some(([url]) => String(url).includes('name=shell-a1b2c3')),
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
  test('removing the machine\'s ONLY workspace stops its agent and removes the workspace outright', async () => {
    seedMachine('m1');
    const workspaceId = selectMachine('m1')(store())!.activeWorkspaceId;
    const workspace = selectMachine('m1')(store())!.workspaces[workspaceId];
    store().bindPaneTerminal('m1', workspaceId, workspace.activePaneId, { name: 'shell-solo' });

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('Workspace 1')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      const machine = selectMachine('m1')(store())!;
      assert({
        given: 'a machine with exactly one workspace holding a running pane, remove confirmed',
        should:
          'stop the agent server-side and drop the workspace — this used to EMPTY it in place instead, which left an un-removable row that New terminal then duplicated',
        actual: {
          deletedRunningAgent: killCalls().some(([url]) => String(url).includes('name=shell-solo')),
          workspaceCount: Object.keys(machine.workspaces).length,
          active: machine.activeWorkspaceId,
        },
        expected: { deletedRunningAgent: true, workspaceCount: 0, active: '' },
      });
    });
  });

  // Inverted (Phase 1). The old shape this guarded — a pane bound at a
  // checkout its workspace doesn't share — is now unrepresentable: a pane
  // stores {name, kind} and the checkout comes from the workspace. So the kill
  // re-derives (project, branch, name) from the WORKSPACE, and a bind naming
  // another node is rejected outright rather than persisted and defended
  // against forever after.
  test('removing a workspace kills each pane\'s session at the WORKSPACE\'s checkout', async () => {
    seedMachine('m1', { level: 'branch', projectName: 'app', branchName: 'main' });
    const workspaceId = selectMachine('m1')(store())!.activeWorkspaceId;
    const workspace = selectMachine('m1')(store())!.workspaces[workspaceId];
    store().bindPaneTerminal('m1', workspaceId, workspace.activePaneId, {
      projectName: 'app',
      branchName: 'main',
      name: 'wanderer',
    });

    renderLeaves(<WorkspaceLeaves machineId="m1" node={BRANCH_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('Workspace 1')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      const killUrl = String(killCalls().find(([url]) => String(url).includes('name=wanderer'))?.[0] ?? '');
      assert({
        given: 'a workspace checked out at app/main holding a running pane, remove confirmed',
        should: 'DELETE the session under that checkout — a bare name would address the machine root, a different terminal',
        actual: {
          project: killUrl.includes('projectName=app'),
          branch: killUrl.includes('branchName=main'),
        },
        expected: { project: true, branch: true },
      });
    });
  });

  test('a pane bound at a node the workspace is not checked out at is REJECTED', async () => {
    seedMachine('m1'); // machine-scope workspace
    const workspaceId = selectMachine('m1')(store())!.activeWorkspaceId;
    const paneId = selectMachine('m1')(store())!.workspaces[workspaceId].activePaneId;

    let rejected = false;
    try {
      store().bindPaneTerminal('m1', workspaceId, paneId, { projectName: 'app', branchName: 'main', name: 'wanderer' });
    } catch {
      rejected = true;
    }

    assert({
      given: 'a branch-scoped session bound into a machine-scoped workspace',
      should:
        'reject it and leave the pane empty — this is the shape every foreign-pane defence existed for, and it is now unrepresentable rather than defended',
      actual: {
        rejected,
        pane: selectMachine('m1')(store())!.workspaces[workspaceId].columns[0].panes[0].scope,
      },
      expected: { rejected: true, pane: null },
    });
  });

  // Same invariant as TerminalPanes' close-and-kill: a session can be shown in
  // two panes at once (openTerminal's doc), including panes of DIFFERENT
  // workspaces — removing one workspace must not pull the PTY out from under
  // the other one still showing it.
  test('removing a workspace spares a session another workspace\'s pane still shows', async () => {
    seedMachine('m1');
    const firstId = selectMachine('m1')(store())!.activeWorkspaceId;
    const first = selectMachine('m1')(store())!.workspaces[firstId];
    store().bindPaneTerminal('m1', firstId, first.activePaneId, { name: 'shared' });
    const secondId = store().createWorkspace('m1');
    const second = selectMachine('m1')(store())!.workspaces[secondId];
    store().bindPaneTerminal('m1', secondId, second.activePaneId, { name: 'shared' });

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('Workspace 1')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(Object.keys(selectMachine('m1')(store())!.workspaces)).toEqual([secondId]));
    assert({
      given: 'two workspaces whose panes show the SAME session, the first removed',
      should: 'drop the workspace but leave the PTY alone — the surviving workspace is still showing it',
      actual: killCalls().filter(([url]) => String(url).includes('name=shared')).length,
      expected: 0,
    });
  });

  test('two panes of the removed workspace showing ONE session kill it once, and the dialog counts it once', async () => {
    seedMachine('m1');
    const workspaceId = selectMachine('m1')(store())!.activeWorkspaceId;
    const workspace = selectMachine('m1')(store())!.workspaces[workspaceId];
    store().bindPaneTerminal('m1', workspaceId, workspace.activePaneId, { name: 'twice' });
    store().splitRight('m1', workspaceId, workspace.activePaneId);
    const withSplit = selectMachine('m1')(store())!.workspaces[workspaceId];
    store().bindPaneTerminal('m1', workspaceId, withSplit.columns[1].panes[0].id, { name: 'twice' });

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('Workspace 1')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await screen.findByText(/stops its 1 running agent/);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      assert({
        given: 'one session shown in both panes of the workspace being removed',
        should: 'DELETE it exactly once — the second call would 404 and surface a spurious failure toast',
        actual: killCalls().filter(([url]) => String(url).includes('name=twice')).length,
        expected: 1,
      });
    });
  });

  // A 404 on the kill means the session is already gone — this call's GOAL
  // state. Treating it as a failure made the workspace permanently
  // unremovable: the kill rejected, the confirm dialog stayed open, and every
  // retry hit the same 404 — an unremovable listing, the exact bug class this
  // PR exists to kill.
  test('removing a workspace whose pane\'s session is already gone server-side still removes it', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async (_url, options) =>
      (options as RequestInit | undefined)?.method === 'DELETE'
        ? new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
        : new Response(JSON.stringify({ agentTerminals: [] }), { status: 200 }),
    );
    seedMachine('m1');
    const workspaceId = selectMachine('m1')(store())!.activeWorkspaceId;
    const workspace = selectMachine('m1')(store())!.workspaces[workspaceId];
    store().bindPaneTerminal('m1', workspaceId, workspace.activePaneId, { name: 'ghost' });

    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('Workspace 1')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove workspace/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      assert({
        given: 'a workspace whose only pane references a session the server no longer has, remove confirmed',
        should: 'treat the 404 kill as already-done and remove the workspace — not keep the dialog open on a retry loop that can never succeed',
        actual: Object.keys(selectMachine('m1')(store())!.workspaces).length,
        expected: 0,
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
        JSON.stringify({ agentTerminals: [{ name: 'orphan-1', agentType: 'shell', createdAt: '2026-01-01' }] }),
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

  describe('inline rename', () => {
    test('double-clicking a workspace name opens an editable input, pre-filled with its current name', async () => {
      seedMachine('m1');
      renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

      const row = await screen.findByText('Workspace 1');
      await userEvent.dblClick(row);

      const input = screen.getByLabelText('Rename workspace Workspace 1') as HTMLInputElement;
      assert({
        given: 'a workspace name double-clicked',
        should: 'show an input pre-filled with the current name',
        actual: input.value,
        expected: 'Workspace 1',
      });
    });

    test('Enter commits the new name and pushes it to the server', async () => {
      seedMachine('m1');
      const workspaceId = selectMachine('m1')(store())!.activeWorkspaceId;
      renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

      await userEvent.dblClick(await screen.findByText('Workspace 1'));
      const input = screen.getByLabelText('Rename workspace Workspace 1');
      await userEvent.clear(input);
      await userEvent.type(input, 'Renamed{Enter}');

      await waitFor(() => {
        assert({
          given: 'a new name typed and Enter pressed',
          should: 'commit the rename locally and PATCH it to the server',
          actual: {
            name: selectMachine('m1')(store())!.workspaces[workspaceId].name,
            stillEditing: screen.queryByLabelText(/Rename workspace/) !== null,
          },
          expected: { name: 'Renamed', stillEditing: false },
        });
      });
      const [, options] = patchCallsTo('/api/machines/workspaces')[0] ?? [];
      expect(JSON.parse((options as RequestInit).body as string)).toMatchObject({
        machineId: 'm1',
        workspaceId,
        name: 'Renamed',
      });
    });

    test('Escape cancels without saving the draft', async () => {
      seedMachine('m1');
      const workspaceId = selectMachine('m1')(store())!.activeWorkspaceId;
      renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

      await userEvent.dblClick(await screen.findByText('Workspace 1'));
      const input = screen.getByLabelText('Rename workspace Workspace 1');
      await userEvent.clear(input);
      await userEvent.type(input, 'Abandoned draft{Escape}');

      assert({
        given: 'a draft typed then Escape pressed',
        should: 'discard the draft and leave the original name untouched',
        actual: selectMachine('m1')(store())!.workspaces[workspaceId].name,
        expected: 'Workspace 1',
      });
      expect(patchCallsTo('/api/machines/workspaces')).toHaveLength(0);
    });

    // Regression (CodeRabbit): in Chromium, unmounting the still-focused
    // input (which Escape/Enter both do, by closing the editor) can itself
    // fire a native `blur` event. Without a skip-next-blur guard, that blur
    // would re-enter the commit path — resurrecting the cancelled draft after
    // Escape, or firing a redundant second commit after Enter.
    test('a blur event firing immediately after Escape does not resurrect the cancelled draft', async () => {
      seedMachine('m1');
      const workspaceId = selectMachine('m1')(store())!.activeWorkspaceId;
      renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

      await userEvent.dblClick(await screen.findByText('Workspace 1'));
      const input = screen.getByLabelText('Rename workspace Workspace 1') as HTMLInputElement;
      await userEvent.clear(input);
      await userEvent.type(input, 'Abandoned draft');
      fireEvent.keyDown(input, { key: 'Escape' });
      // Simulate the browser firing a native blur as a side effect of the
      // input unmounting right after Escape closed the editor.
      fireEvent.blur(input);

      assert({
        given: "Escape followed by a blur event on the now-unmounted input",
        should: 'still leave the original name untouched — the blur must not re-commit the cancelled draft',
        actual: selectMachine('m1')(store())!.workspaces[workspaceId].name,
        expected: 'Workspace 1',
      });
      expect(patchCallsTo('/api/machines/workspaces')).toHaveLength(0);
    });

    test('a blur event firing immediately after Enter does not fire a redundant second commit', async () => {
      seedMachine('m1');
      renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

      await userEvent.dblClick(await screen.findByText('Workspace 1'));
      const input = screen.getByLabelText('Rename workspace Workspace 1') as HTMLInputElement;
      await userEvent.clear(input);
      await userEvent.type(input, 'Renamed');
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);

      await waitFor(() => expect(patchCallsTo('/api/machines/workspaces')).toHaveLength(1));
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
        hasRemoveButton: within(row).queryByRole('button', { name: /Remove session legacy-cli/ }) !== null,
      },
      expected: { adoptedAnything: 0, hasRemoveButton: true },
    });
  });

  // The OTHER un-removable listing: a supported-type orphan rendered
  // its remove button only when `!launchable`, so a supported unclaimed session
  // had no remove affordance at all. The only stop path was "remove the
  // workspace holding it" — which is precisely what an unclaimed session lacks.
  test('a LAUNCHABLE unclaimed session is removable too, not just adoptable', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      new Response(
        JSON.stringify({
          agentTerminals: [{ name: 'shell-runner', agentType: 'shell', createdAt: '2026-01-01' }],
        }),
        { status: 200 },
      ),
    );
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('shell-runner')).closest('.group') as HTMLElement;

    assert({
      given: 'an unclaimed session whose agent type IS supported',
      should: 'still offer a remove button — it has no workspace to remove instead',
      actual: within(row).queryByRole('button', { name: /Remove session shell-runner/ }) !== null,
      expected: true,
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
    await userEvent.click(within(row).getByRole('button', { name: /Remove session legacy-cli/ }));

    await waitFor(() => {
      assert({
        given: 'the remove button on an unlaunchable session',
        should: 'DELETE it by name server-side, exactly like a normal running agent',
        actual: killCalls().some(([url]) => String(url).includes('name=legacy-cli')),
        expected: true,
      });
    });
  });

  // The pane-close orphan fix's DOM-level contract: the row leaves the list in
  // the same render as the removal click — not after a DELETE round-trip whose
  // revalidation might silently fail and strand the row.
  test('removing an unclaimed session drops the row BEFORE the DELETE resolves', async () => {
    let resolveDelete!: (response: Response) => void;
    let deleted = false;
    vi.mocked(fetchWithAuth).mockImplementation((url, init) => {
      if ((init as RequestInit | undefined)?.method === 'DELETE') {
        deleted = true;
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            agentTerminals: deleted
              ? []
              : [{ name: 'shell-orphan', agentType: 'shell', createdAt: '2026-01-01' }],
          }),
          { status: 200 },
        ),
      );
    });
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('shell-orphan')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove session shell-orphan/ }));

    assert({
      given: 'a removal whose DELETE is still in flight',
      should: 'have already dropped the row from the DOM (optimistic, same render)',
      actual: screen.queryByText('shell-orphan'),
      expected: null,
    });

    await act(async () => {
      resolveDelete(new Response(null, { status: 204 }));
    });
    assert({
      given: 'the DELETE then succeeding',
      should: 'keep the row gone',
      actual: screen.queryByText('shell-orphan'),
      expected: null,
    });
  });

  // Self-review finding (PR #2053): unlike removing a live workspace (routed
  // through ConfirmRemoveDialog, which reports a thrown error via toast), a
  // fire-and-forget remove call with nothing observing the rejection would
  // silently no-op on failure — the row stays, but the user gets no signal why.
  test('a failed removal is reported via toast AND the row rolls back into the list', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async (url, init) =>
      (init as RequestInit | undefined)?.method === 'DELETE'
        ? new Response(JSON.stringify({ error: 'Failed to remove' }), { status: 500 })
        : new Response(
            JSON.stringify({
              agentTerminals: [{ name: 'legacy-cli', agentType: 'pagespace-cli', createdAt: '2026-01-01' }],
            }),
            { status: 200 },
          ),
    );
    renderLeaves(<WorkspaceLeaves machineId="m1" node={MACHINE_NODE} onSelectWorkspace={vi.fn()} />);

    const row = (await screen.findByText('legacy-cli')).closest('.group') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /Remove session legacy-cli/ }));

    await waitFor(() => {
      assert({
        given: 'a DELETE that fails 5xx for an unclaimed session\'s remove button',
        should: 'surface the failure via toast.error rather than swallowing it',
        actual: vi.mocked(toast.error).mock.calls.length,
        expected: 1,
      });
    });
    // Rollback: the agent may genuinely still be running (and billing) — the
    // row is the only way left to reach it, so it must come back.
    await waitFor(() => {
      assert({
        given: 'the failed removal',
        should: 'restore the row to the list — still reachable, still removable',
        actual: screen.queryByText('legacy-cli') !== null,
        expected: true,
      });
    });
  });
});

describe('WorkspaceNodeExtras', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useMachineWorkspaceStore.setState({ machines: {} });
  });

  test('shows no running-count badge when nothing is running', () => {
    renderLeaves(<WorkspaceNodeExtras machineId="m1" node={MACHINE_NODE} />);

    assert({
      given: 'a machine with no running agents',
      should: 'render no running-count badge',
      actual: screen.queryByText(/running/i),
      expected: null,
    });
  });

  test('shows a running-count badge scoped to the node', () => {
    seedMachine('m1');
    const workspace = selectMachine('m1')(store())!.workspaces[selectMachine('m1')(store())!.activeWorkspaceId];
    store().bindPaneTerminal('m1', workspace.id, workspace.activePaneId, { name: 'shell-a1b2c3' });

    renderLeaves(<WorkspaceNodeExtras machineId="m1" node={MACHINE_NODE} />);

    assert({
      given: 'one running pane at machine scope',
      should: 'show a "1 running" badge',
      actual: screen.getByText('1 running').textContent,
      expected: '1 running',
    });
  });

  // Regression: WorkspaceNodeExtras used to also render a "New workspace" +
  // trigger — that's now the node row's single "+" action palette
  // (NodeActionPalette, via MachineTree's onWorkspaceCreated prop) instead.
  test('renders no add/create trigger of its own — that lives in the node row\'s single "+" palette now', () => {
    renderLeaves(<WorkspaceNodeExtras machineId="m1" node={MACHINE_NODE} />);

    assert({
      given: 'WorkspaceNodeExtras rendered standalone',
      should: 'expose no button — it is a read-only badge',
      actual: screen.queryByRole('button'),
      expected: null,
    });
  });
});
