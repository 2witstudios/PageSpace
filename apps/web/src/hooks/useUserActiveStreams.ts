'use client';

import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { UserActiveStream } from '@/lib/agents/running-badges';

/**
 * The caller's own in-flight assistant streams, across every channel — what the
 * Agents tree's running dots are computed from (see
 * `lib/agents/running-badges.ts`, which does the actual deciding).
 *
 * Polling, not sockets. The alternative would be joining a room per agent the
 * sidebar can see, which is a subscription fan-out proportional to the tree just
 * to render a dot; a 15s poll of one endpoint is the cheaper shape and the
 * staleness it admits (a dot up to 15s late) is invisible at this granularity.
 * The endpoint's `scope=user` mode answers "what is streaming" and deliberately
 * carries no `parts`, so the response stays small however long a run has been
 * going.
 *
 * NOT paused while editing. Several hooks on this surface pause revalidation via
 * `useEditingStore.isAnyEditing()` to keep SWR from clobbering a document mid-
 * edit — but an active AI stream REGISTERS an editing session ('ai-streaming'),
 * so applying that pause here would freeze this poll during exactly the window
 * it exists to observe, and the dots would never clear. There is nothing to
 * clobber: this hook owns no user-editable state.
 */

const EMPTY_STREAMS: UserActiveStream[] = [];

const ACTIVE_STREAMS_KEY = '/api/ai/chat/active-streams?scope=user';

/** Default poll interval. Slow enough to be free, fast enough that a dot feels live. */
export const ACTIVE_STREAMS_REFRESH_MS = 15_000;

const fetcher = async (url: string): Promise<{ streams: UserActiveStream[] }> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch active streams: ${response.status}`);
  }
  return response.json();
};

export interface UseUserActiveStreamsResult {
  streams: UserActiveStream[];
  isLoading: boolean;
  error: Error | undefined;
  mutate: () => void;
}

export function useUserActiveStreams(
  options: { enabled?: boolean; refreshInterval?: number } = {},
): UseUserActiveStreamsResult {
  const { enabled = true, refreshInterval = ACTIVE_STREAMS_REFRESH_MS } = options;

  const { data, error, isLoading, mutate } = useSWR<{ streams: UserActiveStream[] }>(
    // A disabled key is how a caller that must not enumerate the user's streams
    // (an unauthenticated or non-admin surface) declines to fetch at all, rather
    // than fetching and discarding.
    enabled ? ACTIVE_STREAMS_KEY : null,
    fetcher,
    {
      refreshInterval,
      revalidateOnFocus: true,
      dedupingInterval: 5_000,
      // A failed poll must not blank the dots that are still correct — the next
      // tick repairs it, and a stale dot beats a flickering one.
      keepPreviousData: true,
    },
  );

  return {
    streams: data?.streams ?? EMPTY_STREAMS,
    isLoading: isLoading && !data,
    error: error as Error | undefined,
    mutate: () => {
      void mutate();
    },
  };
}
