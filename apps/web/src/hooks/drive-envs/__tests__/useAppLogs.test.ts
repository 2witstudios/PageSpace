import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockSocket = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockSocket,
}));

import { useAppLogs } from '../useAppLogs';

describe('useAppLogs subscribe/unsubscribe payload contract', () => {
  beforeEach(() => {
    mockSocket.emit.mockReset();
    mockSocket.on.mockReset();
    mockSocket.off.mockReset();
  });

  it('emits app:logs:subscribe with { envId, flyAppName } when both are present', () => {
    renderHook(() => useAppLogs('env-1', 'pgs-app-abc'));

    expect(mockSocket.emit).toHaveBeenCalledWith('app:logs:subscribe', {
      envId: 'env-1',
      flyAppName: 'pgs-app-abc',
    });
  });

  it('does not subscribe when envId is null', () => {
    renderHook(() => useAppLogs(null, 'pgs-app-abc'));
    expect(mockSocket.emit).not.toHaveBeenCalledWith('app:logs:subscribe', expect.anything());
  });

  it('does not subscribe when flyAppName is null', () => {
    renderHook(() => useAppLogs('env-1', null));
    expect(mockSocket.emit).not.toHaveBeenCalledWith('app:logs:subscribe', expect.anything());
  });

  it('emits app:logs:unsubscribe with { flyAppName } on unmount', () => {
    const { unmount } = renderHook(() => useAppLogs('env-1', 'pgs-app-abc'));
    mockSocket.emit.mockClear();

    unmount();

    expect(mockSocket.emit).toHaveBeenCalledWith('app:logs:unsubscribe', { flyAppName: 'pgs-app-abc' });
  });
});
