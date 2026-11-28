import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ data: undefined as unknown, fetchWithAuth: vi.fn() }));

vi.mock('swr', () => ({ default: () => ({ data: mocks.data, error: undefined, isLoading: false, mutate: vi.fn() }) }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: mocks.fetchWithAuth }));

import { useHomeSignals } from '../useHomeSignals';

const pulse = (signInRequired: unknown) => ({
  summary: null,
  signInRequired,
  shouldRefresh: false,
  signals: [],
  context: { userId: 'u1', displayName: 'Ada', timezone: 'UTC', driveIds: [], drivesInUse: [], lastVisitAt: null, pulseEnabled: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = undefined;
});

describe('useHomeSignals and a withheld Pulse summary (D-OW-62)', () => {
  it('SEC-2 (partial) passes on what the server says unlocks the withheld summary', () => {
    mocks.data = pulse({ code: 'org_reauthentication_required', orgIds: ['org_a'] });
    const { result } = renderHook(() => useHomeSignals());
    expect(result.current.signInRequired).toEqual({ code: 'org_reauthentication_required', orgIds: ['org_a'] });
  });

  it('is null when the summary is served, and while loading', () => {
    mocks.data = pulse(null);
    expect(renderHook(() => useHomeSignals()).result.current.signInRequired).toBeNull();
    mocks.data = undefined;
    expect(renderHook(() => useHomeSignals()).result.current.signInRequired).toBeNull();
  });
});
