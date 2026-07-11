'use client';

import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export interface DriveMachine {
  id: string;
  title: string;
  updatedAt: string;
}

const fetcher = (url: string) =>
  fetchWithAuth(url).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'Failed to fetch machines');
    }
    return res.json() as Promise<{ machines: DriveMachine[] }>;
  });

/**
 * Every Machine page in a drive — the root tier of the Development surface's
 * aggregated Machine → Project → Branch → session tree. Pass a `null` `driveId`
 * (the driveless `/dashboard/development` route) to disable fetching.
 */
export function useDriveMachines(driveId: string | null) {
  const key = driveId ? `/api/machines?driveId=${encodeURIComponent(driveId)}` : null;

  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: false,
  });

  return {
    machines: data?.machines ?? [],
    isLoading,
    error: error as Error | undefined,
    mutate,
  };
}
