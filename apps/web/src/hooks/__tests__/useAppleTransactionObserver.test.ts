import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  channel: 'apple' as 'apple' | 'stripe' | 'none',
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../useBillingVisibility', () => ({ useBillingVisibility: () => ({ channel: mocks.channel }) }));
vi.mock('@/lib/iap/apple-store', () => ({ startAppleTransactionObserver: mocks.start }));

import { useAppleTransactionObserver } from '../useAppleTransactionObserver';

describe('useAppleTransactionObserver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.start.mockReturnValue(mocks.stop);
  });

  it('starts the observer on the Apple channel when signed in, and stops it on unmount', async () => {
    mocks.channel = 'apple';
    const { unmount } = renderHook(() => useAppleTransactionObserver(true));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    unmount();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('does nothing while signed out', async () => {
    mocks.channel = 'apple';
    renderHook(() => useAppleTransactionObserver(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each(['stripe', 'none'] as const)('does nothing on the %s channel', async (channel) => {
    mocks.channel = channel;
    renderHook(() => useAppleTransactionObserver(true));
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
