/**
 * Tests for useAccessRevocation hook
 * Handles graceful client-side response to server-initiated permission revocation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Use vi.hoisted to ensure mock variables are available before mock factories run
const { mockPush, mockToast, mockSocket } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockToast: Object.assign(vi.fn(), { error: vi.fn() }),
  mockSocket: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

const mockPathname = '/drives/test-drive-id/pages/test-page-id';

// Mock the router
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: vi.fn(),
  }),
  usePathname: () => mockPathname,
}));

// Mock toast notifications
vi.mock('sonner', () => ({
  toast: mockToast,
}));

// Mock socket store - returns socket instance directly when selector accesses state.socket
vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: vi.fn((selector) => {
    if (typeof selector === 'function') {
      return selector({ socket: mockSocket });
    }
    return mockSocket;
  }),
}));

import { useAccessRevocation } from '../useAccessRevocation';

describe('useAccessRevocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('given socket connected, should register access_revoked listener', () => {
    renderHook(() => useAccessRevocation());

    expect(mockSocket.on).toHaveBeenCalledWith(
      'access_revoked',
      expect.any(Function)
    );
  });

  it('given hook unmounts, should remove access_revoked listener', () => {
    const { unmount } = renderHook(() => useAccessRevocation());

    unmount();

    expect(mockSocket.off).toHaveBeenCalledWith(
      'access_revoked',
      expect.any(Function)
    );
  });

  describe('when access_revoked event received', () => {
    it('given drive room revocation, should show notification and redirect', () => {
      renderHook(() => useAccessRevocation());

      // Get the registered handler
      const handlerCall = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'access_revoked'
      );
      const handler = handlerCall?.[1];

      expect(handler).toBeDefined();

      // Simulate revocation event
      act(() => {
        handler({
          room: 'drive:test-drive-id',
          reason: 'member_removed',
          metadata: {
            driveId: 'test-drive-id',
            driveName: 'Test Drive',
          },
        });
      });

      // Should show toast
      expect(mockToast.error).toHaveBeenCalled();

      // Should redirect to dashboard
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });

    it('given page room revocation, should show notification', () => {
      renderHook(() => useAccessRevocation());

      const handlerCall = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'access_revoked'
      );
      const handler = handlerCall?.[1];

      act(() => {
        handler({
          room: 'test-page-id',
          reason: 'permission_revoked',
          metadata: {
            pageId: 'test-page-id',
          },
        });
      });

      expect(mockToast.error).toHaveBeenCalled();
    });

    it('given activity room revocation, should not show notification (silent)', () => {
      renderHook(() => useAccessRevocation());

      const handlerCall = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'access_revoked'
      );
      const handler = handlerCall?.[1];

      act(() => {
        handler({
          room: 'activity:drive:test-drive-id',
          reason: 'member_removed',
          metadata: {},
        });
      });

      // Activity room revocations are silent (no toast for user)
      // The main drive room revocation will handle the notification
      expect(mockToast.error).not.toHaveBeenCalled();
    });
  });
});
