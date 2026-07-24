/**
 * useMachineWorkspaceSync / useSyncedWorkspaceActions Hook Tests (#2202)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

const { mockFetchWithAuth, mockPost } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
  post: mockPost,
}));

const mockSocket = { current: null as ReturnType<typeof createMockSocket> | null };
vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockSocket.current,
}));

vi.mock('@/hooks/usePageSocketRoom', () => ({
  usePageSocketRoom: vi.fn(),
}));

import { useMachineWorkspaceStore, selectMachine, workspacesOf } from '@/stores/machine-workspace/useMachineWorkspaceStore';
import { useMachineWorkspaceSync, useSyncedWorkspaceActions } from '../useMachineWorkspaceSync';

const MACHINE_ID = 'm1';

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

/** A machine with one workspace open. */
function seedMachine(machineId: string) {
  useMachineWorkspaceStore.getState().ensureMachine(machineId);
  return useMachineWorkspaceStore.getState().createWorkspace(machineId);
}

beforeEach(() => {
  vi.clearAllMocks();
  useMachineWorkspaceStore.setState({ machines: {}, serverRev: {}, pendingVerbs: {} });
  mockSocket.current = createMockSocket();
  mockFetchWithAuth.mockResolvedValue(jsonResponse({ workspaces: [], rev: 0, bootstrapped: true }));
  mockPost.mockResolvedValue({ rev: 1, workspaceId: 'ws-x', workspace: null, applied: true });
});

describe('useMachineWorkspaceSync', () => {
  // Each test uses its OWN machineId — SWR's cache is keyed by the fetch URL
  // and persists across renderHook calls within a file, so reusing one id
  // across tests would silently serve an earlier test's cached response.

  it('ensures the machine has an entry, and NO default workspace, on mount', async () => {
    renderHook(() => useMachineWorkspaceSync('m-default'));

    expect(selectMachine('m-default')(useMachineWorkspaceStore.getState())).toBeDefined();
    expect(workspacesOf(selectMachine('m-default')(useMachineWorkspaceStore.getState()))).toHaveLength(0);
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
  });

  it('hydrates the store from the snapshot GET response, recording its rev', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
        rev: 3,
        bootstrapped: true,
        workspaces: [
          { id: 'ws-server', name: 'Server Workspace', scope: {}, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] },
        ],
      }),
    );

    renderHook(() => useMachineWorkspaceSync('m-snapshot'));

    await waitFor(() => {
      const machine = selectMachine('m-snapshot')(useMachineWorkspaceStore.getState());
      expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-server']);
    });
    expect(useMachineWorkspaceStore.getState().serverRev['m-snapshot']).toBe(3);
  });

  it('given a machine-workspace:verb event for a DIFFERENT machine, ignores it', async () => {
    renderHook(() => useMachineWorkspaceSync('m-filter'));
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());

    act(() => {
      mockSocket.current!._trigger('machine-workspace:verb', {
        machineId: 'other-machine',
        rev: 1,
        workspaceId: 'ws-intruder',
        workspace: { id: 'ws-intruder', name: 'Intruder', scope: {}, columns: [] },
      });
    });

    const machine = selectMachine('m-filter')(useMachineWorkspaceStore.getState());
    expect(workspacesOf(machine).some((w) => w.id === 'ws-intruder')).toBe(false);
  });

  it('given a machine-workspace:verb event upserting a workspace, applies it and advances rev', async () => {
    renderHook(() => useMachineWorkspaceSync('m-verb-upsert'));
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());

    act(() => {
      mockSocket.current!._trigger('machine-workspace:verb', {
        machineId: 'm-verb-upsert',
        rev: 1,
        workspaceId: 'ws-a',
        workspace: { id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] },
      });
    });

    const machine = selectMachine('m-verb-upsert')(useMachineWorkspaceStore.getState());
    expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-a']);
    expect(useMachineWorkspaceStore.getState().serverRev['m-verb-upsert']).toBe(1);
  });

  it('given a machine-workspace:verb event with workspace: null, removes the workspace', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
        rev: 1,
        bootstrapped: true,
        workspaces: [
          { id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] },
          { id: 'ws-b', name: 'B', scope: {}, columns: [{ id: 'col-b', panes: [{ id: 'pane-b', scope: null }] }] },
        ],
      }),
    );

    renderHook(() => useMachineWorkspaceSync('m-delete'));
    await waitFor(() => {
      const machine = selectMachine('m-delete')(useMachineWorkspaceStore.getState());
      expect(workspacesOf(machine)).toHaveLength(2);
    });

    act(() => {
      mockSocket.current!._trigger('machine-workspace:verb', {
        machineId: 'm-delete',
        rev: 2,
        workspaceId: 'ws-b',
        workspace: null,
      });
    });

    await waitFor(() => {
      const machine = selectMachine('m-delete')(useMachineWorkspaceStore.getState());
      expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-a']);
    });
  });

  it('given a stale/duplicate verb echo (rev at or behind the applied one), does not regress local state', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
        rev: 5,
        bootstrapped: true,
        workspaces: [{ id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] }],
      }),
    );

    renderHook(() => useMachineWorkspaceSync('m-stale-verb'));
    await waitFor(() => expect(useMachineWorkspaceStore.getState().serverRev['m-stale-verb']).toBe(5));

    act(() => {
      mockSocket.current!._trigger('machine-workspace:verb', {
        machineId: 'm-stale-verb',
        rev: 5,
        workspaceId: 'ws-a',
        workspace: null,
      });
    });

    // rev 5 is not NEWER than the already-applied rev 5 — dropped, workspace survives.
    const machine = selectMachine('m-stale-verb')(useMachineWorkspaceStore.getState());
    expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-a']);
  });

  it('given a verb event with a GAP (rev more than one past what is applied), resyncs from a fresh snapshot instead of applying it', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({
        rev: 1,
        bootstrapped: true,
        workspaces: [{ id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] }],
      }),
    );

    renderHook(() => useMachineWorkspaceSync('m-gap'));
    await waitFor(() => expect(useMachineWorkspaceStore.getState().serverRev['m-gap']).toBe(1));

    // The next resync GET reflects the "true" state at rev 4 (workspaces
    // created/removed by the missed verbs 2 and 3), not what a naive apply
    // of this single verb's payload could have derived on its own.
    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({
        rev: 4,
        bootstrapped: true,
        workspaces: [
          { id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] },
          { id: 'ws-c', name: 'C', scope: {}, columns: [{ id: 'col-c', panes: [{ id: 'pane-c', scope: null }] }] },
        ],
      }),
    );

    // rev 4 arrives while this browser is only at rev 1 — a gap (missed 2 and 3).
    act(() => {
      mockSocket.current!._trigger('machine-workspace:verb', {
        machineId: 'm-gap',
        rev: 4,
        workspaceId: 'ws-c',
        workspace: { id: 'ws-c', name: 'C', scope: {}, columns: [{ id: 'col-c', panes: [{ id: 'pane-c', scope: null }] }] },
      });
    });

    await waitFor(() => expect(useMachineWorkspaceStore.getState().serverRev['m-gap']).toBe(4));
    const machine = selectMachine('m-gap')(useMachineWorkspaceStore.getState());
    expect(workspacesOf(machine).map((w) => w.id).sort()).toEqual(['ws-a', 'ws-c']);
    // The resync GET was actually issued, not just an incidental rev match.
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('given a verb event exactly ONE past what is applied (no gap), applies it directly without resyncing', async () => {
    renderHook(() => useMachineWorkspaceSync('m-no-gap'));
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(1));

    act(() => {
      mockSocket.current!._trigger('machine-workspace:verb', {
        machineId: 'm-no-gap',
        rev: 1,
        workspaceId: 'ws-a',
        workspace: { id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] },
      });
    });

    const machine = selectMachine('m-no-gap')(useMachineWorkspaceStore.getState());
    expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-a']);
    expect(useMachineWorkspaceStore.getState().serverRev['m-no-gap']).toBe(1);
    // No extra resync GET beyond the initial hydrate.
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });

  // A revalidation (reconnect, focus) is now safe to re-apply: applyServerSnapshot
  // is rev-gated, so a SECOND GET response can never regress state a later verb
  // (or a higher-rev snapshot) already applied.
  it('a later revalidation at a LOWER rev than already applied is discarded (no regression)', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ rev: 1, bootstrapped: true, workspaces: [{ id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] }] }),
    );
    renderHook(() => useMachineWorkspaceSync('m-revalidate'));
    await waitFor(() => expect(useMachineWorkspaceStore.getState().serverRev['m-revalidate']).toBe(1));

    // A verb bumps this browser to rev 2 (e.g. a live create).
    act(() => {
      useMachineWorkspaceStore.getState().applyServerVerb('m-revalidate', {
        rev: 2,
        workspaceId: 'ws-b',
        workspace: { id: 'ws-b', name: 'B', scope: {}, columns: [{ id: 'col-b', panes: [{ id: 'pane-b', scope: null }] }] },
      });
    });
    expect(workspacesOf(selectMachine('m-revalidate')(useMachineWorkspaceStore.getState()))).toHaveLength(2);

    // A stale rev-1 snapshot lands late (e.g. a slow revalidation started before the verb).
    act(() => {
      useMachineWorkspaceStore.getState().applyServerSnapshot('m-revalidate', 1, [
        { id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] },
      ]);
    });

    // Discarded — ws-b (from the higher-rev verb) survives.
    expect(workspacesOf(selectMachine('m-revalidate')(useMachineWorkspaceStore.getState())).map((w) => w.id).sort()).toEqual(['ws-a', 'ws-b']);
  });

  it('given TWO mounted instances for the same machine, both converge on the same snapshot (dual-mount is harmless)', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
        rev: 1,
        bootstrapped: true,
        workspaces: [{ id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] }],
      }),
    );

    renderHook(() => {
      useMachineWorkspaceSync('m-dual-mount');
      useMachineWorkspaceSync('m-dual-mount');
    });

    await waitFor(() => {
      const machine = selectMachine('m-dual-mount')(useMachineWorkspaceStore.getState());
      expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-a']);
    });
    expect(useMachineWorkspaceStore.getState().serverRev['m-dual-mount']).toBe(1);
  });
});

describe('useSyncedWorkspaceActions', () => {
  it('createWorkspace creates locally, then POSTs the queued create-workspace verb', () => {
    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));

    let id = '';
    act(() => {
      id = result.current.createWorkspace();
    });

    expect(workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState())).map((w) => w.id)).toContain(id);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/machines/workspaces/verbs',
      expect.objectContaining({ machineId: MACHINE_ID, verb: expect.objectContaining({ type: 'create-workspace', workspaceId: id }) }),
    );
  });

  it('on a successful push, settles the pending verb and applies the server response immediately (no need to wait for the socket echo)', async () => {
    mockPost.mockImplementation(async (_url: string, body: { verb: { workspaceId: string } }) => ({
      rev: 7,
      workspaceId: body.verb.workspaceId,
      workspace: { id: body.verb.workspaceId, name: 'Server-confirmed', scope: {}, columns: [{ id: 'c1', panes: [{ id: 'p1', scope: null }] }] },
      applied: true,
    }));

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    let id = '';
    act(() => {
      id = result.current.createWorkspace();
    });

    await waitFor(() => {
      expect(useMachineWorkspaceStore.getState().pendingVerbs[MACHINE_ID] ?? []).toHaveLength(0);
    });
    expect(useMachineWorkspaceStore.getState().serverRev[MACHINE_ID]).toBe(7);
    expect(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState())?.workspaces[id]?.name).toBe('Server-confirmed');
  });

  it('on a push that fails (network error), settles the pending verb and resyncs from a fresh GET', async () => {
    mockPost.mockRejectedValueOnce(new Error('network'));
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ rev: 9, bootstrapped: true, workspaces: [{ id: 'ws-resynced', name: 'Resynced', scope: {}, columns: [{ id: 'c1', panes: [{ id: 'p1', scope: null }] }] }] }),
    );

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.createWorkspace();
    });

    await waitFor(() => expect(useMachineWorkspaceStore.getState().serverRev[MACHINE_ID]).toBe(9));
    expect(useMachineWorkspaceStore.getState().pendingVerbs[MACHINE_ID] ?? []).toHaveLength(0);
    expect(workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState())).map((w) => w.id)).toEqual(['ws-resynced']);
  });

  it('a second dependent action on the same machine does not POST until the first push has settled server-side', async () => {
    let resolveFirstPush!: (value: { rev: number; workspaceId: string; workspace: null; applied: boolean }) => void;
    const firstPush = new Promise<{ rev: number; workspaceId: string; workspace: null; applied: boolean }>((resolve) => {
      resolveFirstPush = resolve;
    });
    mockPost.mockImplementationOnce(() => firstPush);

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    let firstId = '';
    act(() => {
      firstId = result.current.createWorkspace();
    });
    expect(mockPost).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.splitRight(firstId, workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0].activePaneId);
    });
    // The dependent split's POST must not have gone out yet — the create it
    // depends on hasn't resolved server-side.
    expect(mockPost).toHaveBeenCalledTimes(1);

    resolveFirstPush({ rev: 1, workspaceId: firstId, workspace: null, applied: true });
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost).toHaveBeenNthCalledWith(
      2,
      '/api/machines/workspaces/verbs',
      expect.objectContaining({ verb: expect.objectContaining({ type: 'split-pane', workspaceId: firstId }) }),
    );
  });

  it('an action whose local verb did not apply (unresolvable target) does NOT push anything', () => {
    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));

    act(() => {
      result.current.removeWorkspace('never-existed');
    });

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('removeWorkspace removes locally, then pushes the remove-workspace verb', () => {
    seedMachine(MACHINE_ID);
    useMachineWorkspaceStore.getState().createWorkspace(MACHINE_ID);
    const second = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[1];

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.removeWorkspace(second.id);
    });

    expect(
      workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState())).some((w) => w.id === second.id),
    ).toBe(false);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/machines/workspaces/verbs',
      expect.objectContaining({ verb: { type: 'remove-workspace', workspaceId: second.id } }),
    );
  });

  it('splitRight pushes a split-pane verb', () => {
    seedMachine(MACHINE_ID);
    const workspace = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.splitRight(workspace.id, workspace.activePaneId);
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/api/machines/workspaces/verbs',
      expect.objectContaining({
        verb: expect.objectContaining({ type: 'split-pane', workspaceId: workspace.id, fromPaneId: workspace.activePaneId, direction: 'right' }),
      }),
    );
  });

  it('renameWorkspace pushes a rename-workspace verb carrying only the new name', () => {
    seedMachine(MACHINE_ID);
    const workspace = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.renameWorkspace(workspace.id, 'Renamed');
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/api/machines/workspaces/verbs',
      expect.objectContaining({ verb: { type: 'rename-workspace', workspaceId: workspace.id, name: 'Renamed' } }),
    );
  });

  it('closePane on a pane with siblings pushes a close-pane verb and never removes the workspace locally', () => {
    seedMachine(MACHINE_ID);
    const workspace = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];
    useMachineWorkspaceStore.getState().splitRight(MACHINE_ID, workspace.id, workspace.activePaneId);
    const withSplit = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];
    const paneIds = withSplit.columns.flatMap((column) => column.panes.map((pane) => pane.id));
    expect(paneIds).toHaveLength(2);

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.closePane(workspace.id, paneIds[1]);
    });

    const final = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];
    expect(final.columns.flatMap((column) => column.panes)).toHaveLength(1);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/machines/workspaces/verbs',
      expect.objectContaining({ verb: expect.objectContaining({ type: 'close-pane', workspaceId: workspace.id, paneId: paneIds[1] }) }),
    );
  });

  it('closePane on the LAST pane removes the workspace locally and pushes close-pane (the server decides workspace removal)', () => {
    seedMachine(MACHINE_ID);
    const workspace = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.closePane(workspace.id, workspace.activePaneId);
    });

    expect(workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))).toHaveLength(0);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/machines/workspaces/verbs',
      expect.objectContaining({ verb: { type: 'close-pane', workspaceId: workspace.id, paneId: workspace.activePaneId } }),
    );
  });

  it('openTerminal born-bound pushes a create-workspace verb carrying the session', () => {
    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));

    act(() => {
      result.current.openTerminal({ name: 'shell-a1' });
    });

    expect(mockPost).toHaveBeenCalledWith(
      '/api/machines/workspaces/verbs',
      expect.objectContaining({ verb: expect.objectContaining({ type: 'create-workspace', session: { name: 'shell-a1' } }) }),
    );
  });

  it('openTerminal for a session already showing pushes add-pane, not a second create', async () => {
    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.openTerminal({ name: 'shell-a1' });
    });
    // The second push is deliberately chained behind the first's settlement
    // (per-machine push sequencing — see `enqueuePush`), so wait for it here.
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    mockPost.mockClear();

    act(() => {
      result.current.openTerminal({ name: 'shell-a1' });
    });

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/api/machines/workspaces/verbs',
        expect.objectContaining({ verb: expect.objectContaining({ type: 'add-pane', session: { name: 'shell-a1' } }) }),
      ),
    );
  });
});
