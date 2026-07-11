'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { fetchWithAuth, post, del } from '@/lib/auth/auth-fetch';

export interface MachineBranch {
  branchName: string;
  createdAt: string;
}

const fetcher = (url: string) =>
  fetchWithAuth(url).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'Failed to fetch branches');
    }
    return res.json() as Promise<{ branches: MachineBranch[] }>;
  });

/** Branches tier of the Terminal workspace navigator — one isolated Sprite per branch-terminal. */
export function useMachineBranches(machineId: string | null, projectName: string | null) {
  const key =
    machineId && projectName
      ? `/api/machines/branches?machineId=${encodeURIComponent(machineId)}&projectName=${encodeURIComponent(projectName)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: false,
  });

  const addBranch = useCallback(
    async (branchName: string) => {
      if (!machineId || !projectName) throw new Error('No active project');
      const result = await post<{ branch: { branchName: string; resumed: boolean } }>('/api/machines/branches', {
        machineId,
        projectName,
        branchName,
      });
      await mutate();
      return result.branch;
    },
    [machineId, projectName, mutate],
  );

  const removeBranch = useCallback(
    async (branchName: string) => {
      if (!machineId || !projectName) throw new Error('No active project');
      await del(
        `/api/machines/branches?machineId=${encodeURIComponent(machineId)}&projectName=${encodeURIComponent(projectName)}&branchName=${encodeURIComponent(branchName)}`,
      );
      await mutate();
    },
    [machineId, projectName, mutate],
  );

  return {
    branches: data?.branches ?? [],
    isLoading,
    error: error as Error | undefined,
    mutate,
    addBranch,
    removeBranch,
  };
}
