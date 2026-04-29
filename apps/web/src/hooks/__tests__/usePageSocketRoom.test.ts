import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockSocket } = vi.hoisted(() => {
  const handlers: Record<string, (() => void)[]> = {};

  const mockSocket = {
    on: vi.fn((event: string, handler: () => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    off: vi.fn((event: string, handler: () => void) => {
      if (handlers[event]) {
        handlers[event] = handlers[event].filter((h) => h !== handler);
      }
    }),
    emit: vi.fn(),
    _trigger: (event: string) => {
      handlers[event]?.slice().forEach((h) => h());
    },
    _reset: () => {
      Object.keys(handlers).forEach((k) => { handlers[k] = []; });
    },
  };

  return { mockSocket };
});

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockSocket,
}));

import { usePageSocketRoom } from '../usePageSocketRoom';

describe('usePageSocketRoom', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket._reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('given socket and pageId are available, should emit join_channel on mount', () => {
    renderHook(() => usePageSocketRoom('page-a'));
    expect(mockSocket.emit).toHaveBeenCalledWith('join_channel', 'page-a');
  });

  it('given pageId is undefined, should not emit join_channel', () => {
    renderHook(() => usePageSocketRoom(undefined));
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it('given pageId changes, should emit join_channel for the new pageId', () => {
    let pageId = 'page-a';
    const { rerender } = renderHook(() => usePageSocketRoom(pageId));

    pageId = 'page-b';
    rerender();

    expect(mockSocket.emit).toHaveBeenCalledWith('join_channel', 'page-a');
    expect(mockSocket.emit).toHaveBeenCalledWith('join_channel', 'page-b');
  });

  // B1 — reconnect re-join
  it('given socket reconnects while hook is mounted, should re-emit join_channel', () => {
    renderHook(() => usePageSocketRoom('page-a'));

    const countAfterMount = mockSocket.emit.mock.calls.length;

    act(() => { mockSocket._trigger('connect'); });

    expect(mockSocket.emit.mock.calls.length).toBe(countAfterMount + 1);
    expect(mockSocket.emit).toHaveBeenLastCalledWith('join_channel', 'page-a');
  });

  it('given unmount, should remove the connect listener so reconnects no longer emit', () => {
    const { unmount } = renderHook(() => usePageSocketRoom('page-a'));

    unmount();

    expect(mockSocket.off).toHaveBeenCalledWith('connect', expect.any(Function));
  });
});
