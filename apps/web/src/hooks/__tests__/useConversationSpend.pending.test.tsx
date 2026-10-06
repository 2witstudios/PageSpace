import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth, put: vi.fn() }));
vi.mock('@/stores/useSocketStore', () => ({ useSocketStore: (select: (s: { socket: null }) => unknown) => select({ socket: null }) }));

import { PENDING_CONVERSATION_RETRY_LIMIT, PENDING_CONVERSATION_RETRY_MS, pendingConversationRetryMs, useConversationSpend } from '../useConversationSpend';

const spend = {
  conversationId: 'c-new',
  driveId: 'd-product',
  chosenWalletId: null,
  options: [],
  resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'w-product' },
};
const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
const found = () => new Response(JSON.stringify(spend), { status: 200 });
// A fresh cache per test, as each conversation is in the app.
const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('a new conversation whose row is not saved yet', () => {
  it('SPEND-2 (partial) the source is asked again while the conversation is not stored, a bounded number of times, then no more', () => {
    expect(pendingConversationRetryMs(1)).toBe(PENDING_CONVERSATION_RETRY_MS);
    expect(pendingConversationRetryMs(5)).toBe(PENDING_CONVERSATION_RETRY_MS);
    // The first read and ten retries have missed: stop.
    expect(pendingConversationRetryMs(PENDING_CONVERSATION_RETRY_LIMIT)).toBe(PENDING_CONVERSATION_RETRY_MS);
    expect(pendingConversationRetryMs(PENDING_CONVERSATION_RETRY_LIMIT + 1)).toBe(0);
    expect(pendingConversationRetryMs(0)).toBe(0);
  });

  it('SPEND-2 (partial) a 404 before the conversation is saved is not cached forever: once the row exists the strip gets the source', async () => {
    fetchWithAuth.mockResolvedValueOnce(notFound()).mockResolvedValue(found());

    const { result } = renderHook(() => useConversationSpend('c-new', { driveId: 'd-product', isGlobal: false }), { wrapper });

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    expect(result.current.spend).toBeNull();
    await waitFor(() => expect(result.current.spend).toMatchObject({ resolved: { source: 'drive_wallet' } }), { timeout: PENDING_CONVERSATION_RETRY_MS * 4 });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('SPEND-2 (partial) a conversation that is never saved is asked exactly 1 + 10 times, then no more (no endless polling)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchWithAuth.mockImplementation(async () => notFound());
      renderHook(() => useConversationSpend('c-never', { driveId: 'd-product', isGlobal: false }), { wrapper });
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(PENDING_CONVERSATION_RETRY_MS);
      expect(fetchWithAuth).toHaveBeenCalledTimes(1 + PENDING_CONVERSATION_RETRY_LIMIT);
      await vi.advanceTimersByTimeAsync(PENDING_CONVERSATION_RETRY_MS * 10);
      expect(fetchWithAuth).toHaveBeenCalledTimes(1 + PENDING_CONVERSATION_RETRY_LIMIT);
    } finally {
      vi.useRealTimers();
    }
  });
});

