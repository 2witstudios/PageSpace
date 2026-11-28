/**
 * useGlobalDriveSocket — the sidebar's and picker's live drive list (Spec X-4). A drive's visibility change is
 * broadcast as `drive:updated`, and a membership change as `drive:member_*`, on the person's own
 * `user:<id>:drives` channel. The hook refetches the list once, after a debounce, so the sidebar updates without a
 * reload, and it catches up on the list when it mounts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';

const { fetchDrives } = vi.hoisted(() => ({ fetchDrives: vi.fn() }));
const mockSocket = createMockSocket();

vi.mock('../useSocket', () => ({
  useSocket: () => mockSocket,
}));

vi.mock('../useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('../useDrive', () => ({
  useDriveStore: (select: (state: { fetchDrives: typeof fetchDrives }) => unknown) => select({ fetchDrives }),
}));

import { useGlobalDriveSocket } from '../useGlobalDriveSocket';

const DEBOUNCE_MS = 500;

const driveEvent = (operation: string, extra: Record<string, unknown> = {}) => ({ driveId: 'drive-1', operation, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  fetchDrives.mockReset();
  mockSocket._handlers.clear();
  mockSocket.emit.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useGlobalDriveSocket', () => {
  it('X-4 (partial) joins the person\'s own drives channel and catches up on the drive list when it mounts', () => {
    const { unmount } = renderHook(() => useGlobalDriveSocket());

    expect(mockSocket.emit).toHaveBeenCalledWith('join', 'user:user-1:drives');
    expect(fetchDrives).toHaveBeenCalledTimes(1);
    expect(fetchDrives).toHaveBeenCalledWith(true, true);

    unmount();
  });

  it('X-4 (partial) a drive:updated (how a visibility change reaches a member) refetches the list after the debounce, and not before', () => {
    const { unmount } = renderHook(() => useGlobalDriveSocket());
    fetchDrives.mockClear();

    act(() => mockSocket._trigger('drive:updated', driveEvent('updated')));
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS - 1));
    expect(fetchDrives).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(fetchDrives).toHaveBeenCalledTimes(1);
    expect(fetchDrives).toHaveBeenCalledWith(true, true);

    unmount();
  });

  it('X-4 (partial) a burst of drive and membership changes inside the debounce window is one refetch', () => {
    const { unmount } = renderHook(() => useGlobalDriveSocket());
    fetchDrives.mockClear();

    act(() => {
      mockSocket._trigger('drive:updated', driveEvent('updated'));
      mockSocket._trigger('drive:member_added', driveEvent('member_added'));
      mockSocket._trigger('drive:member_removed', driveEvent('member_removed'));
    });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));

    expect(fetchDrives).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('X-4 (partial) a command or workflow broadcast on the drive channel is not a drive-list change and refetches nothing', () => {
    const { unmount } = renderHook(() => useGlobalDriveSocket());
    fetchDrives.mockClear();

    act(() => {
      mockSocket._trigger('drive:updated', driveEvent('updated', { resourceType: 'command' }));
      mockSocket._trigger('drive:updated', driveEvent('updated', { resourceType: 'workflow' }));
    });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS * 2));

    expect(fetchDrives).not.toHaveBeenCalled();

    unmount();
  });

  it('X-4 (partial) leaving the page leaves the drives channel, removes its listeners, and drops a pending refetch', () => {
    const { unmount } = renderHook(() => useGlobalDriveSocket());
    fetchDrives.mockClear();

    act(() => mockSocket._trigger('drive:updated', driveEvent('updated')));
    unmount();
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS * 2));
    act(() => mockSocket._trigger('drive:updated', driveEvent('updated')));
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS * 2));

    expect(mockSocket.emit).toHaveBeenCalledWith('leave', 'user:user-1:drives');
    expect(fetchDrives).not.toHaveBeenCalled();
  });
});
