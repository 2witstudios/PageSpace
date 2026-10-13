import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

const fetchWithAuth = vi.hoisted(() => vi.fn());
// A fake socket whose handlers the tests fire directly: the same room the app subscribes to.
const socketState = vi.hoisted(() => ({ handlers: new Map<string, (payload?: unknown) => void>() }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth, put: vi.fn() }));
vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: (select: (s: { socket: unknown }) => unknown) => select({
    socket: {
      on: (event: string, handler: (payload?: unknown) => void) => { socketState.handlers.set(event, handler); },
      off: (event: string) => { socketState.handlers.delete(event); },
    },
  }),
}));

import { SPEND_PREFERENCES_EVENT, useConversationSpend, useDriveSpend } from '../useConversationSpend';

const spend = {
  conversationId: 'c1',
  driveId: 'd-product',
  chosenWalletId: null,
  options: [],
  resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'w-product' },
};
const driveSpend = { driveId: 'd-product', options: [], resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'w-product' } };
const found = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;

beforeEach(() => {
  fetchWithAuth.mockReset();
  socketState.handlers.clear();
});

// JOURNEYS-3: window 1 changed a spend preference (conversation source, default, absolute
// switch); window 2's displayed preview must refetch — the event is the invalidation.
describe('a spend preference change in another window', () => {
  it('refetches the conversation preview of the same person', async () => {
    fetchWithAuth.mockResolvedValue(found(spend));
    const { result } = renderHook(() => useConversationSpend('c1', { driveId: 'd-product', isGlobal: false }), { wrapper });
    await waitFor(() => expect(result.current.spend).not.toBeNull());
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    socketState.handlers.get(SPEND_PREFERENCES_EVENT)?.();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.spend).not.toBeNull());
  });

  it('refetches the drive preview shown while no conversation is in view', async () => {
    fetchWithAuth.mockResolvedValue(found(driveSpend));
    const { result } = renderHook(() => useDriveSpend('d-product'), { wrapper });
    await waitFor(() => expect(result.current.spend).not.toBeNull());
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    socketState.handlers.get(SPEND_PREFERENCES_EVENT)?.();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
  });
});
