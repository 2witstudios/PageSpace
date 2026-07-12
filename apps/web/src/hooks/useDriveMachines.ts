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

  // This list must be able to RECOVER, which is why it revalidates at all (the
  // sibling machine hooks don't). A machine can drop out of it without having
  // been deleted — the per-page permission check swallows DB errors and reports
  // "cannot view" — and the surface responds by hiding that machine. Fetched
  // once and never again, a single blip would hide a live machine for the rest
  // of the session, and the only ways out (reload, or leave and return) both
  // unmount the keep-alive host and disconnect every warm terminal.
  //
  // It also means a machine created elsewhere shows up without a reload, and
  // (by dropping the previous `revalidateOnFocus: false`) that coming back to the
  // tab recovers immediately rather than waiting out the interval.
  //
  // Cheap: one indexed query on an admin-only surface, and SWR suppresses the
  // poll entirely while the tab is hidden. A poll cannot churn the keep-alive LRU
  // — note that is NOT because SWR preserves the array's identity (it only does
  // that when the whole payload is deep-equal, and `updatedAt` moves whenever a
  // Machine page is touched). It's because the consumers key on the IDS alone:
  // `useStickyMachineIds` and the host's `validKey` both collapse the list to its
  // ids, so a payload that carries new timestamps but the same machines is inert.
  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    refreshInterval: 30_000,
  });

  return {
    machines: data?.machines ?? [],
    isLoading,
    error: error as Error | undefined,
    mutate,
  };
}
