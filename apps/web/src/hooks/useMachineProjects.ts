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

/** Projects tier of the Terminal workspace navigator — git repos tracked on a Machine. */
export function useMachineProjects(terminalId: string | null) {
  const key = terminalId ? `/api/machines/projects?terminalId=${encodeURIComponent(terminalId)}` : null;

  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: false,
  });

  const addProject = useCallback(
    async (name: string, repoUrl: string) => {
      if (!terminalId) throw new Error('No active machine');
      const result = await post<{ project: MachineProject }>('/api/machines/projects', { terminalId, name, repoUrl });
      await mutate();
      return result.project;
    },
    [terminalId, mutate],
  );

  const removeProject = useCallback(
    async (name: string) => {
      if (!terminalId) throw new Error('No active machine');
      await del(`/api/machines/projects?terminalId=${encodeURIComponent(terminalId)}&name=${encodeURIComponent(name)}`);
      await mutate();
    },
    [terminalId, mutate],
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
