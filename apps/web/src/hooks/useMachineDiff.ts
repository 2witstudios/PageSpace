'use client';

import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { MachineDiffFile, MachineDiffScope } from '@pagespace/lib/services/sandbox/machine-diff-scope';

/**
 * The Diff tab's changed-file list for one branch + scope, or the explicit
 * `{ notApplicable: true }` the route returns for the 'committed'/'branch'
 * scopes on the repo's main branch. Consumers detect the main-branch case from
 * this flag — never by string-matching the branch name. `mergeBase` is present
 * for the committed/branch scopes; the client doesn't need it (the pair form
 * below re-derives both sides server-side), so it's typed loosely.
 */
export type MachineDiffFilesResponse =
  | { notApplicable: true }
  | {
      notApplicable: false;
      scope: MachineDiffScope;
      files: MachineDiffFile[];
      truncated: boolean;
      mergeBase?: string | null;
    };

/**
 * One file's original/modified pair for a scope. A side is `null` when the file
 * doesn't exist there (an added file's original, a deleted file's modified);
 * the caller coerces null to '' before handing it to Monaco.
 */
export type MachineDiffPairResponse =
  | { notApplicable: true }
  | {
      notApplicable: false;
      scope: MachineDiffScope;
      path: string;
      original: string | null;
      modified: string | null;
    };

const fetcher = <T>(url: string): Promise<T> =>
  fetchWithAuth(url).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'Failed to load diff');
    }
    return res.json() as Promise<T>;
  });

/**
 * Fetch the changed-file list for a branch + scope. Inert (no request) until a
 * branch is selected AND a scope is set — the tab drives fetching on-demand
 * (branch-select / scope-change / refresh), never eagerly.
 */
export function useMachineDiffFiles(
  machineId: string,
  projectName: string | null,
  branchName: string | null,
  scope: MachineDiffScope | null,
) {
  const key =
    projectName && branchName && scope
      ? `/api/machines/diff?machineId=${encodeURIComponent(machineId)}` +
        `&projectName=${encodeURIComponent(projectName)}` +
        `&branchName=${encodeURIComponent(branchName)}` +
        `&scope=${scope}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<MachineDiffFilesResponse>(key, fetcher, {
    revalidateOnFocus: false,
  });

  return { data, error: error as Error | undefined, isLoading, mutate };
}

/**
 * Fetch one file's diff pair, but only while `enabled` (i.e. the file card is
 * expanded) — so a scope with 100 changed files issues 0 content requests until
 * the user opens a card. `previousPath`/`status` are threaded so a rename's
 * original resolves to its pre-rename location and a deletion's modified side is
 * forced null (see the diff route's per-file contract).
 */
export function useMachineDiffPair(
  machineId: string,
  projectName: string | null,
  branchName: string | null,
  scope: MachineDiffScope | null,
  file: MachineDiffFile | null,
  enabled: boolean,
) {
  const key =
    enabled && projectName && branchName && scope && file
      ? (() => {
          const params = new URLSearchParams({
            machineId,
            projectName,
            branchName,
            scope,
            path: file.path,
            status: file.status,
          });
          if (file.previousPath) params.set('previousPath', file.previousPath);
          return `/api/machines/diff?${params.toString()}`;
        })()
      : null;

  const { data, error, isLoading } = useSWR<MachineDiffPairResponse>(key, fetcher, {
    revalidateOnFocus: false,
  });

  return { data, error: error as Error | undefined, isLoading };
}
