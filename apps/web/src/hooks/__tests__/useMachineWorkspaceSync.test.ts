/**
 * useMachineWorkspaceSync / useSyncedWorkspaceActions Hook Tests (#2048)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { mutate } from 'swr';
import { createMockSocket } from '@/test/socket-mocks';

const { mockFetchWithAuth, mockPost, mockPatch, mockDel } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
  mockDel: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
  post: mockPost,
  patch: mockPatch,
  del: mockDel,
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

beforeEach(() => {
  vi.clearAllMocks();
  useMachineWorkspaceStore.setState({ machines: {} });
  mockSocket.current = createMockSocket();
  mockFetchWithAuth.mockResolvedValue(jsonResponse({ workspaces: [], bootstrapped: true }));
  mockPost.mockResolvedValue({ claimed: true, workspaces: [] });
  mockPatch.mockResolvedValue({});
  mockDel.mockResolvedValue({});
});

describe('useMachineWorkspaceSync', () => {
  // Each test uses its OWN machineId — SWR's cache is keyed by the fetch URL
  // and persists across renderHook calls within a file, so reusing one id
  // across tests would silently serve an earlier test's cached response.

  it('ensures the machine has a local default workspace on mount', async () => {
    renderHook(() => useMachineWorkspaceSync('m-default'));

    expect(workspacesOf(selectMachine('m-default')(useMachineWorkspaceStore.getState()))).toHaveLength(1);
    // Let the in-flight SWR fetch/hydrate settle before the test tears down,
    // so its state update lands inside this test's act scope, not the next one's.
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
  });

  it('given the server reports bootstrapped, hydrates the store from the GET response without bootstrapping', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
        bootstrapped: true,
        workspaces: [
          { id: 'ws-server', name: 'Server Workspace', scope: {}, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] },
        ],
      }),
    );

    renderHook(() => useMachineWorkspaceSync('m-bootstrapped'));

    await waitFor(() => {
      const machine = selectMachine('m-bootstrapped')(useMachineWorkspaceStore.getState());
      expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-server']);
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('given the server reports NOT bootstrapped, POSTs this browser\'s local workspace to /bootstrap', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ bootstrapped: false, workspaces: [] }));
    mockPost.mockResolvedValue({
      claimed: true,
      workspaces: [{ id: 'ws-seeded', name: 'Seeded', scope: {}, columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: null }] }] }],
    });

    renderHook(() => useMachineWorkspaceSync('m-unbootstrapped'));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/api/machines/workspaces/bootstrap',
        expect.objectContaining({ machineId: 'm-unbootstrapped' }),
      ),
    );
    await waitFor(() => {
      const machine = selectMachine('m-unbootstrapped')(useMachineWorkspaceStore.getState());
      expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-seeded']);
    });
  });

  it('given a machine-workspace:created event for a DIFFERENT machine, ignores it', async () => {
    renderHook(() => useMachineWorkspaceSync('m-filter'));
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());

    act(() => {
      mockSocket.current!._trigger('machine-workspace:created', {
        machineId: 'other-machine',
        id: 'ws-intruder',
        name: 'Intruder',
        scope: {},
        columns: [],
      });
    });

    const machine = selectMachine('m-filter')(useMachineWorkspaceStore.getState());
    expect(workspacesOf(machine).some((w) => w.id === 'ws-intruder')).toBe(false);
  });

  it('given a rename-only machine-workspace:updated event for a workspace ALREADY known locally, merges the name and keeps its columns', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
        bootstrapped: true,
        workspaces: [{ id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] }],
      }),
    );

    renderHook(() => useMachineWorkspaceSync('m-update-known'));
    await waitFor(() => {
      const machine = selectMachine('m-update-known')(useMachineWorkspaceStore.getState());
      expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-a']);
    });

    act(() => {
      mockSocket.current!._trigger('machine-workspace:updated', {
        machineId: 'm-update-known',
        workspaceId: 'ws-a',
        name: 'Renamed elsewhere',
        // columns omitted — a rename-only broadcast.
      });
    });

    const machine = selectMachine('m-update-known')(useMachineWorkspaceStore.getState());
    const workspace = workspacesOf(machine).find((w) => w.id === 'ws-a');
    expect(workspace?.name).toBe('Renamed elsewhere');
    expect(workspace?.columns).toEqual([{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }]);
  });

  it('given a rename-only machine-workspace:updated event for a workspace UNKNOWN locally, ignores it rather than planting a zero-column entry', async () => {
    renderHook(() => useMachineWorkspaceSync('m-update-unknown'));
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());

    act(() => {
      mockSocket.current!._trigger('machine-workspace:updated', {
        machineId: 'm-update-unknown',
        workspaceId: 'ws-never-seen',
        name: 'Renamed elsewhere',
        // columns omitted, and this browser has never seen ws-never-seen.
      });
    });

    const machine = selectMachine('m-update-unknown')(useMachineWorkspaceStore.getState());
    expect(workspacesOf(machine).some((w) => w.id === 'ws-never-seen')).toBe(false);
  });

  it('given a SECOND SWR revalidation after the initial hydrate, does NOT re-run the full-list replace (a pending local-only create must survive)', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
        bootstrapped: true,
        workspaces: [{ id: 'ws-a', name: 'A', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] }],
      }),
    );

    renderHook(() => useMachineWorkspaceSync('m-revalidate'));
    await waitFor(() => {
      const machine = selectMachine('m-revalidate')(useMachineWorkspaceStore.getState());
      expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-a']);
    });

    // A local-only workspace appears (its own create POST is still in flight,
    // e.g. behind a slow CSRF round trip) — mergeServerWorkspaces would drop
    // this as an unpublished straggler if the full-list hydrate ran again.
    act(() => {
      useMachineWorkspaceStore.getState().createWorkspace('m-revalidate');
    });
    const beforeRevalidate = workspacesOf(selectMachine('m-revalidate')(useMachineWorkspaceStore.getState()));
    expect(beforeRevalidate).toHaveLength(2);

    // Simulate a background SWR revalidation (e.g. reconnect) returning the
    // SAME stale server list (it still doesn't know about the pending create).
    await act(async () => {
      await mutate(
        '/api/machines/workspaces?machineId=m-revalidate',
        { bootstrapped: true, workspaces: [{ id: 'ws-a', name: 'A (revalidated)', scope: {}, columns: [{ id: 'col-a', panes: [{ id: 'pane-a', scope: null }] }] }] },
        { revalidate: false },
      );
    });

    const afterRevalidate = workspacesOf(selectMachine('m-revalidate')(useMachineWorkspaceStore.getState()));
    expect(afterRevalidate).toHaveLength(2);
  });

  it('given a machine-workspace:deleted event for this machine, removes the workspace', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
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
      mockSocket.current!._trigger('machine-workspace:deleted', { machineId: 'm-delete', workspaceId: 'ws-b' });
    });

    await waitFor(() => {
      const machine = selectMachine('m-delete')(useMachineWorkspaceStore.getState());
      expect(workspacesOf(machine).map((w) => w.id)).toEqual(['ws-a']);
    });
  });
});

describe('useSyncedWorkspaceActions', () => {
  it('createWorkspace creates locally, then POSTs the new workspace', () => {
    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));

    let id = '';
    act(() => {
      id = result.current.createWorkspace();
    });

    expect(workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState())).map((w) => w.id)).toContain(id);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/machines/workspaces',
      expect.objectContaining({ machineId: MACHINE_ID, id }),
    );
  });

  it('createWorkspace that LOSES the first-writer-wins race adopts the winner\'s row instead of keeping its own diverged local state', async () => {
    // The server echoes back a DIFFERENT name/columns than what this browser
    // POSTed, with `created: false` — simulating another browser having
    // already materialized this exact (client-derived) id first.
    mockPost.mockImplementation(async (_url: string, body: { id: string }) => ({
      created: false,
      workspace: {
        id: body.id,
        name: "winner's name",
        scope: {},
        columns: [{ id: 'col-winner', panes: [{ id: 'pane-winner', scope: null }] }],
      },
    }));

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    let id = '';
    act(() => {
      id = result.current.createWorkspace();
    });

    await waitFor(() => {
      const machine = selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState());
      const adopted = machine?.workspaces[id];
      expect(adopted?.name).toBe("winner's name");
      expect(adopted?.columns).toEqual([{ id: 'col-winner', panes: [{ id: 'pane-winner', scope: null }] }]);
    });
  });

  it('removeWorkspace removes locally, then DELETEs it', () => {
    useMachineWorkspaceStore.getState().ensureMachine(MACHINE_ID);
    const machine = selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState())!;
    useMachineWorkspaceStore.getState().createWorkspace(MACHINE_ID);
    const second = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[1];

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.removeWorkspace(second.id);
    });

    expect(
      workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState())).some((w) => w.id === second.id),
    ).toBe(false);
    expect(mockDel).toHaveBeenCalledWith(
      expect.stringContaining(`machineId=${MACHINE_ID}`),
    );
    expect(mockDel).toHaveBeenCalledWith(expect.stringContaining(`workspaceId=${second.id}`));
    void machine;
  });

  it('splitRight PATCHes the resulting layout via fetchWithAuth; on a real 404 status it falls back to POST-create', async () => {
    useMachineWorkspaceStore.getState().ensureMachine(MACHINE_ID);
    const workspace = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];
    mockFetchWithAuth.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'not_found' }) });

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.splitRight(workspace.id, workspace.activePaneId);
    });

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/machines/workspaces',
        expect.objectContaining({ method: 'PATCH', body: expect.stringContaining(workspace.id) }),
      ),
    );
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/machines/workspaces', expect.objectContaining({ id: workspace.id })));
  });

  it('splitRight does NOT fall back to POST when the PATCH fails for a status OTHER than 404 — a real HTTP status check, not string-matching the error text', async () => {
    useMachineWorkspaceStore.getState().ensureMachine(MACHINE_ID);
    const workspace = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];
    mockFetchWithAuth.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'error' }) });

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.splitRight(workspace.id, workspace.activePaneId);
    });

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/machines/workspaces',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('splitRight does NOT fall back to POST when the PATCH succeeds', async () => {
    useMachineWorkspaceStore.getState().ensureMachine(MACHINE_ID);
    const workspace = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];
    mockFetchWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ workspace: {} }) });

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.splitRight(workspace.id, workspace.activePaneId);
    });

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    expect(mockPost).not.toHaveBeenCalled();
  });
});
