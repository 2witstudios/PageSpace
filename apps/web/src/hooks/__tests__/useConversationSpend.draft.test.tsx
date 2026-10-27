import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';
const { fetchWithAuth, put } = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth, put }));
vi.mock('@/stores/useSocketStore', () => ({ useSocketStore: (select: (s: { socket: null }) => unknown) => select({ socket: null }) }));
import { useConversationSpend } from '../useConversationSpend';
import { ComposerSpendStrip } from '@/components/wallets/ComposerSpendStrip';

const choices = [
  { source: 'drive_wallet', walletId: 'drive-wallet', label: 'Product wallet', driveName: 'Product', orgName: 'Org', remainingCents: 100, remainingCredits: '1' },
  { source: 'seat_allowance', walletId: 'pool-wallet', label: 'Org seat', driveName: 'Product', orgName: 'Org', remainingCents: 100, remainingCredits: '1' },
  { source: 'own_credits', walletId: 'own-wallet', label: 'Your credits', driveName: null, orgName: null, remainingCents: 100, remainingCredits: '1' },
];
const preview = { driveId: 'product', options: choices, resolved: { kind: 'spend', source: 'drive_wallet', walletId: 'drive-wallet', fallbackApplied: false, fallbackFrom: null } };
const chosen = { ...preview, conversationId: 'draft', chosenWalletId: 'own-wallet', resolved: { ...preview.resolved, source: 'own_credits', walletId: 'own-wallet' } };
const wrapper = ({ children }: { children: ReactNode }) => <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>{children}</SWRConfig>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchWithAuth.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('/drives/') ? preview : { error: 'Not found' }), { status: url.includes('/drives/') ? 200 : 404 }));
  put.mockResolvedValue(chosen);
});

describe('a fresh global draft source before sending', () => {
  it('Given a missing global row, should preview its drive read-only and explicitly materialize only when choosing', async () => {
    const { result } = renderHook(() => useConversationSpend('draft', { driveId: 'product', isGlobal: true }), { wrapper });
    await waitFor(() => expect(result.current.spend?.options).toHaveLength(3));
    expect(result.current.isPending).toBe(true);
    expect(put).not.toHaveBeenCalled();
    await act(async () => result.current.choose('own-wallet'));
    expect(put).toHaveBeenCalledWith('/api/wallets/conversations/draft?driveId=product', { walletId: 'own-wallet', createGlobalDraft: true });
    expect(result.current.spend?.chosenWalletId).toBe('own-wallet');
    expect(result.current.isPending).toBe(false);
  });

  it('Given a fresh drive draft, should show the composer source and permit a deliberate alternate before its first message', async () => {
    render(<ComposerSpendStrip conversationId="draft" driveId="product" isGlobal hasMessages={false} />, { wrapper });
    expect(await screen.findByTestId('composer-spend-strip')).toHaveTextContent('Product wallet');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('radio', { name: /Your credits/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/wallets/conversations/draft?driveId=product', { walletId: 'own-wallet', createGlobalDraft: true }));
    expect(screen.getByTestId('composer-spend-strip')).toHaveTextContent('Your credits');
  });

  it.each([401, 403, 500])('Given a %s refusal, should not pretend it is a draft or fetch a drive preview', async status => {
    fetchWithAuth.mockResolvedValue(new Response('{}', { status }));
    const { result } = renderHook(() => useConversationSpend('draft', { driveId: 'product', isGlobal: true }), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.isPending).toBe(false);
    expect(result.current.spend).toBeNull();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('Given a persisted explicit source, should never replace it with the drive default while loading or loaded', async () => {
    fetchWithAuth.mockResolvedValue(new Response(JSON.stringify(chosen)));
    const { result } = renderHook(() => useConversationSpend('draft', { driveId: 'product', isGlobal: true }), { wrapper });
    await waitFor(() => expect(result.current.spend?.chosenWalletId).toBe('own-wallet'));
    expect(result.current.isPending).toBe(false);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('Given a draft preview followed by an authentication refusal, should stop showing the preview rather than masking the refusal', async () => {
    const { result } = renderHook(() => useConversationSpend('draft', { driveId: 'product', isGlobal: true }), { wrapper });
    await waitFor(() => expect(result.current.spend?.options).toHaveLength(3));
    fetchWithAuth.mockResolvedValue(new Response('{}', { status: 403 }));
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.isPending).toBe(false);
    expect(result.current.spend).toBeNull();
  });

  it('Given a network failure, should expose the error without a draft preview', async () => {
    fetchWithAuth.mockRejectedValue(new Error('network unavailable'));
    const { result } = renderHook(() => useConversationSpend('draft', { driveId: 'product', isGlobal: true }), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.isPending).toBe(false);
    expect(result.current.spend).toBeNull();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
