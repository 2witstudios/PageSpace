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
  // It also means a machine created elsewhere shows up without a reload. Cheap:
  // one indexed query, on an admin-only surface, and SWR keeps the previous
  // array identity when the ids are unchanged — so a poll that changes nothing
  // doesn't churn the keep-alive LRU.
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
