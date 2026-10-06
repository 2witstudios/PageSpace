import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor, render, screen } from '@testing-library/react';
import { useSideQuestion } from '../useSideQuestion';
import { SideQuestionCard } from '../SideQuestionCard';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: fetchMock }));
vi.mock('@/lib/ai/shared', () => ({ useStreamingRegistration: vi.fn() }));
vi.mock('@/hooks/useConversationSpend', () => ({ useConversationSpend: () => ({ spend: null }) }));

const answer = (headers: Record<string, string>) => {
  let sent = false;
  return {
    ok: true,
    headers: new Headers(headers),
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new TextEncoder().encode('Because.') })),
      }),
    },
  };
};

describe('a side question that fell back to another source', () => {
  it('SPEND-4 (partial) reads the X-Spend-Fallback-* headers and shows the notice on the card', async () => {
    fetchMock.mockResolvedValue(answer({ 'X-Spend-Fallback-From': 'drive_wallet', 'X-Spend-Fallback-To': 'own_credits', 'X-Spend-Fallback-Wallet': 'w-me' }));
    const { result } = renderHook(() => useSideQuestion('conv-1'));
    await act(async () => {
      await result.current.ask('Why?');
    });
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(result.current.state?.spendFallback).toEqual({ from: 'drive_wallet', to: 'own_credits', walletId: 'w-me' });

    const state = result.current.state;
    if (!state) throw new Error('no state');
    render(<SideQuestionCard state={state} onDismiss={() => {}} />);
    expect(screen.getByText("Used your own credits because the drive wallet couldn't cover this.")).toBeTruthy();
  });

  it('SPEND-4 (partial) an answer that spent the chosen source carries no notice', async () => {
    fetchMock.mockResolvedValue(answer({}));
    const { result } = renderHook(() => useSideQuestion('conv-1'));
    await act(async () => {
      await result.current.ask('Why?');
    });
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(result.current.state?.spendFallback).toBeNull();
  });
});
