/**
 * useMachineWorkspaceSync / useSyncedWorkspaceActions Hook Tests (#2048)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
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

  it('splitRight PATCHes the resulting layout; on a 404 it falls back to POST-create', async () => {
    useMachineWorkspaceStore.getState().ensureMachine(MACHINE_ID);
    const workspace = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];
    mockPatch.mockRejectedValueOnce(new Error('not_found'));

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.splitRight(workspace.id, workspace.activePaneId);
    });

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/machines/workspaces', expect.objectContaining({ workspaceId: workspace.id })));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/machines/workspaces', expect.objectContaining({ id: workspace.id })));
  });

  it('splitRight does NOT fall back to POST when the PATCH fails for a reason OTHER than not_found', async () => {
    useMachineWorkspaceStore.getState().ensureMachine(MACHINE_ID);
    const workspace = workspacesOf(selectMachine(MACHINE_ID)(useMachineWorkspaceStore.getState()))[0];
    mockPatch.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useSyncedWorkspaceActions(MACHINE_ID));
    act(() => {
      result.current.splitRight(workspace.id, workspace.activePaneId);
    });

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(mockPost).not.toHaveBeenCalled();
  });
});
