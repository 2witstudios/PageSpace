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

/**
 * Branches tier of the Terminal workspace navigator — one isolated Sprite per branch-terminal.
 *
 * `enabled` gates ONLY the list fetch (default `true`) — see `useMachineProjects`'s
 * doc comment for why it must not also gate `addBranch`/`removeBranch`.
 */
export function useMachineBranches(machineId: string | null, projectName: string | null, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const key =
    machineId && projectName && enabled
      ? `/api/machines/branches?machineId=${encodeURIComponent(machineId)}&projectName=${encodeURIComponent(projectName)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: false,
  });

  /**
   * `branchName` is free text — the SERVER normalizes it (see
   * `normalizeBranchName`), so the returned `branchName` is the canonical one and
   * is what callers must display, never what the user typed.
   *
   * `createdNew` says whether an existing upstream branch was checked out or a
   * brand-new one was created off the default HEAD. Normalization can rewrite a
   * name that DID exist upstream into one that doesn't (`_wip` → `wip`, since our
   * charset rejects a leading `_`), and the user would otherwise have no way to
   * tell an empty branch from their real one. Threaded through here so the spawn
   * flow can SAY so; no caller renders it yet.
   */
  const addBranch = useCallback(
    async (branchName: string) => {
      if (!machineId || !projectName) throw new Error('No active project');
      const result = await post<{
        branch: { branchName: string; resumed: boolean; createdNew?: boolean };
      }>('/api/machines/branches', {
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
