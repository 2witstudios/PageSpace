/**
 * useSidebarBadges live-update coverage.
 *
 * The Channels nav badge only ever moved on `notification:new` (an @mention),
 * so an ordinary channel message left the number stale until a page reload —
 * even though the server already fans `inbox:channel_updated` out to every
 * viewable member's personal notifications room on each post. These tests pin
 * the subscription list and the trailing debounce that keeps a busy channel
 * from firing one badge refetch per message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

const { mockMutate } = vi.hoisted(() => ({ mockMutate: vi.fn() }));
const mockSocket = createMockSocket();

vi.mock('../useSocket', () => ({ useSocket: () => mockSocket }));

vi.mock('swr', () => ({
  default: () => ({ data: undefined, mutate: mockMutate }),
}));

vi.mock('@/stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (state: { unreadCount: number }) => unknown) =>
    selector({ unreadCount: 0 }),
}));

import { useSidebarBadges } from '../useSidebarBadges';

const DEBOUNCE_MS = 250;

const flushDebounce = () => act(() => { vi.advanceTimersByTime(DEBOUNCE_MS); });

describe('useSidebarBadges', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSocket._handlers.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('revalidates when a new channel message arrives', async () => {
    renderHook(() => useSidebarBadges());
    mockMutate.mockClear(); // the mount-effect revalidation is not what we assert

    act(() => { mockSocket._trigger('inbox:channel_updated', { id: 'ch_1' }); });
    flushDebounce();

    expect(mockMutate).toHaveBeenCalled();
  });

  it.each([
    'notification:new',
    'inbox:dm_updated',
    'inbox:channel_updated',
    'inbox:thread_updated',
    'inbox:read_status_changed',
  ])('subscribes to %s', (event) => {
    renderHook(() => useSidebarBadges());
    expect(mockSocket._handlers.get(event)?.length).toBeGreaterThan(0);
  });

  it('coalesces a burst of events into a single revalidation', () => {
    renderHook(() => useSidebarBadges());
    mockMutate.mockClear();

    act(() => {
      for (let i = 0; i < 5; i++) mockSocket._trigger('inbox:channel_updated', { id: 'ch_1' });
    });
    flushDebounce();

    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('removes its handlers and cancels a pending revalidation on unmount', () => {
    const { unmount } = renderHook(() => useSidebarBadges());
    act(() => { mockSocket._trigger('inbox:channel_updated', { id: 'ch_1' }); });

    mockMutate.mockClear();
    unmount();
    flushDebounce();

    expect(mockMutate).not.toHaveBeenCalled();
    for (const handlers of mockSocket._handlers.values()) {
      expect(handlers).toHaveLength(0);
    }
  });
});
