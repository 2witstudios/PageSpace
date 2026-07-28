/**
 * The running-dot feed.
 *
 * The property that matters most is the one that isn't here: this hook does NOT
 * pause on `useEditingStore.isAnyEditing()`. An active AI stream registers an
 * editing session, so the usual pause would freeze the poll during exactly the
 * window it exists to observe — dots would light and never clear.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import React from 'react';

const { mockFetchWithAuth } = vi.hoisted(() => ({ mockFetchWithAuth: vi.fn() }));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
  post: vi.fn(),
  del: vi.fn(),
}));

import { useUserActiveStreams, ACTIVE_STREAMS_REFRESH_MS } from '../useUserActiveStreams';

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const streamRow = {
  messageId: 'msg-1',
  conversationId: 'conv-1',
  channelId: 'agent-1',
  startedAt: '2026-07-28T00:00:00.000Z',
};

beforeEach(() => {
  mockFetchWithAuth.mockReset();
});

describe('useUserActiveStreams', () => {
  it('fetches the user-scoped discovery endpoint', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ streams: [streamRow] }));
    const { result } = renderHook(() => useUserActiveStreams(), { wrapper });

    await waitFor(() => expect(result.current.streams).toHaveLength(1));
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/ai/chat/active-streams?scope=user');
    expect(result.current.streams[0]).toEqual(streamRow);
  });

  it('serves a stable empty array before the first response', () => {
    // Referential stability matters: this feeds a memoized badge derivation, and
    // a fresh `[]` per render would recompute the whole tree's badges every time.
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ streams: [] }));
    const { result, rerender } = renderHook(() => useUserActiveStreams(), { wrapper });
    const first = result.current.streams;
    rerender();
    expect(result.current.streams).toBe(first);
  });

  it('does not fetch when disabled', async () => {
    // The admin gate: a caller who must not enumerate streams declines to fetch
    // at all rather than fetching and discarding.
    const { result } = renderHook(() => useUserActiveStreams({ enabled: false }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(result.current.streams).toEqual([]);
  });

  it('surfaces a failed poll as an error, not as an empty list', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    const { result } = renderHook(() => useUserActiveStreams(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.streams).toEqual([]);
  });

  it('polls on an interval by default', () => {
    // Pinned as a constant so the sidebar and this hook can't disagree about how
    // live a dot is.
    expect(ACTIVE_STREAMS_REFRESH_MS).toBe(15_000);
  });
});
