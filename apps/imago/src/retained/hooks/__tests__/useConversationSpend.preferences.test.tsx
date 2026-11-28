// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

const fetchWithAuth = vi.hoisted(() => vi.fn());
// A fake socket whose handlers the tests fire directly: the same room the app subscribes to.
const socketState = vi.hoisted(() => ({ handlers: new Map<string, (payload?: unknown) => void>() }));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ fetchWithAuth, put: vi.fn() }));
vi.mock('@/retained/stores/useSocketStore', () => ({
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

function useTestSpend(kind: 'conversation' | 'drive') {
  const conversation = useConversationSpend(kind === 'conversation' ? 'c1' : null, { driveId: 'd-product', isGlobal: false });
  const drive = useDriveSpend(kind === 'drive' ? 'd-product' : null);
  return kind === 'conversation' ? conversation : drive;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  socketState.handlers.clear();
});

// JOURNEYS-3: window 1 changed a spend preference (conversation source, default, absolute
// switch); window 2's displayed preview must refetch — the event is the invalidation.
describe('a spend preference change in another window', () => {
  it('refetches the conversation preview of the same person', async () => {
    fetchWithAuth.mockImplementation(async () => found(spend));
    const { result } = renderHook(() => useConversationSpend('c1', { driveId: 'd-product', isGlobal: false }), { wrapper });
    await waitFor(() => expect(result.current.spend).not.toBeNull());
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    act(() => socketState.handlers.get(SPEND_PREFERENCES_EVENT)?.());
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.spend).not.toBeNull());
  });

  it('refetches the drive preview shown while no conversation is in view', async () => {
    fetchWithAuth.mockImplementation(async () => found(driveSpend));
    const { result } = renderHook(() => useDriveSpend('d-product'), { wrapper });
    await waitFor(() => expect(result.current.spend).not.toBeNull());
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    act(() => socketState.handlers.get(SPEND_PREFERENCES_EVENT)?.());
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
  });
});

// A cached source is no longer sending authority after a preference invalidation.
describe('invalidated spend previews', () => {
  it.each(['conversation', 'drive'] as const)('withholds the cached %s source while a replacement read is in flight', async kind => {
    const body = kind === 'conversation' ? spend : driveSpend;
    let finishRead!: (response: Response) => void;
    const replacement = new Promise<Response>(resolve => { finishRead = resolve; });
    fetchWithAuth.mockResolvedValueOnce(found(body)).mockReturnValueOnce(replacement);
    const { result } = renderHook(() => useTestSpend(kind), { wrapper });
    await waitFor(() => expect(result.current.spend).not.toBeNull());
    act(() => socketState.handlers.get(SPEND_PREFERENCES_EVENT)?.());
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    try {
      expect(result.current.spend).toBeNull();
      expect(result.current.isPending).toBe(true);
    } finally {
      await act(async () => finishRead(found({ ...body, resolved: { kind: 'spend', source: 'own_credits', walletId: 'w-personal' } })));
    }
    await waitFor(() => expect(result.current.spend?.resolved).toMatchObject({ walletId: 'w-personal' }));
  });

  it.each(['conversation', 'drive'] as const)('refuses a cached %s source after failed revalidation until a successful retry discloses the new payer', async kind => {
    const body = kind === 'conversation' ? spend : driveSpend;
    fetchWithAuth.mockResolvedValueOnce(found(body)).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const { result } = renderHook(() => useTestSpend(kind), { wrapper });
    await waitFor(() => expect(result.current.spend).not.toBeNull());
    act(() => socketState.handlers.get(SPEND_PREFERENCES_EVENT)?.());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.spend).toBeNull();
    fetchWithAuth.mockResolvedValueOnce(found({ ...body, resolved: { kind: 'spend', source: 'own_credits', walletId: 'w-personal' } }));
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.spend?.resolved).toMatchObject({ walletId: 'w-personal' }));
    expect(result.current.error).toBeUndefined();
  });
});
