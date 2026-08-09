/**
 * THE SOCKET → STORE SEAM for one workspace's node tree.
 *
 * `placeWorkerPane` is the server half of Phase 3's capability (a pane a
 * server-side action put in front of a user); this hook is the half that makes
 * it arrive LIVE rather than on the next page load. Everything it does is a
 * property no other test covers:
 *
 *  - **Mount reads the snapshot.** Unconditional, server-wins structurally.
 *    Without it a grid opened after the placement would render whatever the
 *    store happened to hold.
 *  - **The workspaceId guard.** One socket holds several rooms. Applying a
 *    payload addressed to a DIFFERENT workspace poisons this session's cache
 *    with another session's grid — the guard is the only thing stopping it.
 *  - **Reconnect is a RESYNC, not a resume.** The broadcast transport is
 *    best-effort, so a dropped socket may have missed a rev. Rejoining without
 *    re-reading would leave the grid quietly stale until the user's next edit
 *    409'd.
 *  - **Socket REPLACEMENT.** The store swaps the Socket object outright on the
 *    auth-refresh reconnect path. A hook that kept its listeners on the old
 *    object would be listening to a permanently dead socket forever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

type Handler = (payload: unknown) => void;

/** A Socket.IO double: records subscriptions and can fire them. */
function createMockSocket(id: string) {
  const handlers: Record<string, Handler[]> = {};
  return {
    id,
    on: vi.fn((event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    }),
    off: vi.fn((event: string, handler: Handler) => {
      handlers[event] = (handlers[event] ?? []).filter((registered) => registered !== handler);
    }),
    emit: vi.fn(),
    /** Fire an event to everything still subscribed — a torn-down handler is simply gone. */
    _fire: (event: string, payload?: unknown) => {
      (handlers[event] ?? []).slice().forEach((handler) => handler(payload));
    },
    _handlerCount: (event: string) => (handlers[event] ?? []).length,
  };
}
type MockSocket = ReturnType<typeof createMockSocket>;

const { socketRef, mockApplyRemoteUpdate, mockRefreshSnapshot } = vi.hoisted(() => ({
  socketRef: { current: null as unknown },
  mockApplyRemoteUpdate: vi.fn(),
  mockRefreshSnapshot: vi.fn(),
}));

vi.mock('@/stores/useSocketStore', () => ({
  // The hook subscribes to the socket OBJECT, not the stable accessor — the
  // selector shape is what makes a store-level swap reach it.
  useSocketStore: (selector: (state: { socket: unknown }) => unknown) =>
    selector({ socket: socketRef.current }),
}));

vi.mock('../useAgentWorkspaceStore', () => ({
  useAgentWorkspaceStore: {
    getState: () => ({
      applyRemoteUpdate: mockApplyRemoteUpdate,
      refreshWorkspaceSnapshot: mockRefreshSnapshot,
    }),
  },
}));

import { useWorkspaceLayoutSync } from '../useWorkspaceLayoutSync';

const SESSION = 'ws-mine';
const OTHER_SESSION = 'ws-someone-elses';

function updatePayload(workspaceId: string) {
  return { workspaceId, rev: 12, nodes: [] };
}

let socket: MockSocket;

beforeEach(() => {
  vi.clearAllMocks();
  socket = createMockSocket('socket-a');
  socketRef.current = socket;
  mockRefreshSnapshot.mockResolvedValue(undefined);
});

describe('useWorkspaceLayoutSync — room membership', () => {
  it('joins session:<id> and reads the snapshot on mount', () => {
    renderHook(() => useWorkspaceLayoutSync(SESSION));

    expect(socket.emit).toHaveBeenCalledWith('join_session', SESSION);
    expect(mockRefreshSnapshot).toHaveBeenCalledWith(SESSION);
  });

  it('leaves the room and unregisters BOTH handlers on unmount', () => {
    const { unmount } = renderHook(() => useWorkspaceLayoutSync(SESSION));
    expect(socket._handlerCount('workspace:nodes-updated')).toBe(1);
    expect(socket._handlerCount('connect')).toBe(1);

    unmount();

    expect(socket.emit).toHaveBeenCalledWith('leave_session', SESSION);
    expect(socket._handlerCount('workspace:nodes-updated')).toBe(0);
    expect(socket._handlerCount('connect')).toBe(0);
  });

  it('re-joins for a new sessionId and leaves the old room', () => {
    let sessionId = SESSION;
    const { rerender } = renderHook(() => useWorkspaceLayoutSync(sessionId));

    sessionId = OTHER_SESSION;
    rerender();

    expect(socket.emit).toHaveBeenCalledWith('leave_session', SESSION);
    expect(socket.emit).toHaveBeenCalledWith('join_session', OTHER_SESSION);
  });

  it('still reads the snapshot when there is no socket yet', () => {
    socketRef.current = null;
    renderHook(() => useWorkspaceLayoutSync(SESSION));

    // The mount GET does not wait on a connection — a grid opened before the
    // socket exists must still render the server's truth.
    expect(mockRefreshSnapshot).toHaveBeenCalledWith(SESSION);
  });
});

describe('useWorkspaceLayoutSync — workspace:updated', () => {
  it('applies a payload addressed to THIS workspace', () => {
    renderHook(() => useWorkspaceLayoutSync(SESSION));

    const payload = updatePayload(SESSION);
    act(() => socket._fire('workspace:nodes-updated', payload));

    expect(mockApplyRemoteUpdate).toHaveBeenCalledWith(payload);
  });

  it('DROPS a payload addressed to a different workspace on the same socket', () => {
    renderHook(() => useWorkspaceLayoutSync(SESSION));

    act(() => socket._fire('workspace:nodes-updated', updatePayload(OTHER_SESSION)));

    // One socket holds many rooms; without this guard another session's grid
    // lands on this session's cache.
    expect(mockApplyRemoteUpdate).not.toHaveBeenCalled();
  });

  it('drops a malformed payload rather than throwing inside the handler', () => {
    renderHook(() => useWorkspaceLayoutSync(SESSION));

    expect(() => act(() => socket._fire('workspace:nodes-updated', undefined))).not.toThrow();
    expect(mockApplyRemoteUpdate).not.toHaveBeenCalled();
  });
});

describe('useWorkspaceLayoutSync — reconnect is a resync', () => {
  it('re-joins AND re-reads the snapshot on connect', () => {
    renderHook(() => useWorkspaceLayoutSync(SESSION));
    const joinsAfterMount = socket.emit.mock.calls.filter(([event]) => event === 'join_session').length;
    expect(mockRefreshSnapshot).toHaveBeenCalledTimes(1);

    act(() => socket._fire('connect'));

    expect(socket.emit.mock.calls.filter(([event]) => event === 'join_session')).toHaveLength(
      joinsAfterMount + 1,
    );
    // The re-read is the half that heals a missed rev: rejoining alone would
    // leave the grid stale until the next edit 409'd.
    expect(mockRefreshSnapshot).toHaveBeenCalledTimes(2);
    expect(mockRefreshSnapshot).toHaveBeenLastCalledWith(SESSION);
  });
});

describe('useWorkspaceLayoutSync — disabled', () => {
  it('does nothing at all when enabled is false', () => {
    renderHook(() => useWorkspaceLayoutSync(SESSION, { enabled: false }));

    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.on).not.toHaveBeenCalled();
    expect(mockRefreshSnapshot).not.toHaveBeenCalled();
  });

  it('starts syncing when it becomes enabled', () => {
    let enabled = false;
    const { rerender } = renderHook(() => useWorkspaceLayoutSync(SESSION, { enabled }));

    enabled = true;
    rerender();

    expect(socket.emit).toHaveBeenCalledWith('join_session', SESSION);
    expect(mockRefreshSnapshot).toHaveBeenCalledWith(SESSION);
  });
});

describe('useWorkspaceLayoutSync — the socket is REPLACED (auth-refresh reconnect)', () => {
  it('tears down the old socket and re-subscribes on the new one', () => {
    const { rerender } = renderHook(() => useWorkspaceLayoutSync(SESSION));
    const oldSocket = socket;

    const newSocket = createMockSocket('socket-b');
    socketRef.current = newSocket;
    rerender();

    // Old: fully released.
    expect(oldSocket.emit).toHaveBeenCalledWith('leave_session', SESSION);
    expect(oldSocket._handlerCount('workspace:nodes-updated')).toBe(0);
    expect(oldSocket._handlerCount('connect')).toBe(0);

    // New: joined and listening.
    expect(newSocket.emit).toHaveBeenCalledWith('join_session', SESSION);
    expect(newSocket._handlerCount('workspace:nodes-updated')).toBe(1);
    expect(newSocket._handlerCount('connect')).toBe(1);
  });

  it('keeps applying updates over the replacement socket', () => {
    const { rerender } = renderHook(() => useWorkspaceLayoutSync(SESSION));
    const oldSocket = socket;

    const newSocket = createMockSocket('socket-b');
    socketRef.current = newSocket;
    rerender();

    const payload = updatePayload(SESSION);
    act(() => newSocket._fire('workspace:nodes-updated', payload));
    expect(mockApplyRemoteUpdate).toHaveBeenCalledWith(payload);

    // And the dead socket can no longer reach the store.
    mockApplyRemoteUpdate.mockClear();
    act(() => oldSocket._fire('workspace:nodes-updated', updatePayload(SESSION)));
    expect(mockApplyRemoteUpdate).not.toHaveBeenCalled();
  });
});
