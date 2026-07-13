'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { fetchWithAuth, post, del } from '@/lib/auth/auth-fetch';

export interface MachineProject {
  name: string;
  repoUrl: string;
  path: string;
  createdAt: string;
}

const fetcher = (url: string) =>
  fetchWithAuth(url).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'Failed to fetch projects');
    }
    return res.json() as Promise<{ projects: MachineProject[] }>;
  });

/**
 * Projects tier of the Terminal workspace navigator — git repos tracked on a Machine.
 *
 * `enabled` gates ONLY the list fetch (default `true`) — a caller collapsed by
 * default (e.g. the Development sidebar's per-machine rows) passes `false` to
 * skip firing N requests for N collapsed rows on mount. It must NOT also gate
 * `addProject`/`removeProject`: those mutate via `machineId` directly, which is
 * always known from the caller's own props, never from whether the list
 * happens to be loaded — a row's hover-revealed "Add project" trigger lives in
 * the row itself and must work before the row is ever expanded.
 */
export function useMachineProjects(machineId: string | null, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const key = machineId && enabled ? `/api/machines/projects?machineId=${encodeURIComponent(machineId)}` : null;

  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: false,
  });

  const addProject = useCallback(
    async (name: string, repoUrl: string) => {
      if (!machineId) throw new Error('No active machine');
      // The POST route returns only `{ name, repoUrl, path }` — no `createdAt`
      // (that's set by the DB and only surfaced by the GET list route).
      const result = await post<{ project: Omit<MachineProject, 'createdAt'> }>('/api/machines/projects', { machineId, name, repoUrl });
      await mutate();
      return result.project;
    },
    [machineId, mutate],
  );

  const removeProject = useCallback(
    async (name: string) => {
      if (!machineId) throw new Error('No active machine');
      await del(`/api/machines/projects?machineId=${encodeURIComponent(machineId)}&name=${encodeURIComponent(name)}`);
      await mutate();
    },
    [machineId, mutate],
  );

  return {
    projects: data?.projects ?? [],
    isLoading,
    error: error as Error | undefined,
    mutate,
    addProject,
    removeProject,
  };
}
