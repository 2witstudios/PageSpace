/**
 * useSocket must SUBSCRIBE to the store's socket, not read it through the
 * stable getSocket accessor. The store replaces the Socket object outright —
 * on its initial async creation, and on the auth-refresh `connect(true)` path
 * that disconnects the old socket and mints a new one. A consumer reading
 * through the accessor only noticed a swap on its next incidental re-render;
 * a terminal pane keyed on the socket prop kept listening to a permanently
 * disconnected Socket whose 'connect' event would never fire again — a
 * silently dead pane.
 *
 * This file deliberately uses the REAL useSocketStore (unlike useSocket.test.ts,
 * which mocks the whole store): the property under test is the zustand
 * subscription itself.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Socket } from 'socket.io-client';

// Unauthenticated, so the hook's effect calls disconnect() (a no-op on a null
// socket) instead of connect(), which would try to open a real connection.
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: false, user: null }),
}));

import { useSocket } from '../useSocket';
import { useSocketStore } from '@/stores/useSocketStore';

describe('useSocket — socket swaps reach consumers', () => {
  afterEach(() => {
    act(() => {
      useSocketStore.setState({ socket: null });
    });
  });

  it('given the store replaces the Socket object, should hand consumers the new one WITHOUT an incidental re-render', () => {
    const { result } = renderHook(() => useSocket());
    expect(result.current).toBeNull();

    const swapped = { id: 'socket-after-refresh', connected: true } as unknown as Socket;
    // No rerender() around this — the store subscription alone must propagate.
    act(() => {
      useSocketStore.setState({ socket: swapped });
    });

    expect(result.current).toBe(swapped);
  });
});
