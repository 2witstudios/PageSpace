'use client';

// The /dm index's people: who the viewer can message, loaded through SWR.
// The conversations come from use-messages' useDirectThreads, which is live.

import { useCallback } from 'react';
import useSWR from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { fetchMessageablePeople } from './dm-index-api';

export const useMessageablePeople = () => {
  const client = useApiClient();
  const { data, error, isLoading, mutate } = useSWR(['imago:messageable-people'] as const, () =>
    fetchMessageablePeople(client),
  );
  /** Void action: asks the server again after a failure. */
  const retry = useCallback(() => void mutate(), [mutate]);
  return { people: data, error: error as unknown, isLoading, retry };
};
