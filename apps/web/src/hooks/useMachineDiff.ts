'use client';

import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { MachineDiffFile, MachineDiffScope } from '@pagespace/lib/services/sandbox/machine-diff-scope';
import type { MachineDiffSideContent } from '@pagespace/lib/services/sandbox/machine-diff';

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
 * One SIDE of a file's diff — `{ content, truncated }`, NOT a bare string.
 *
 * This ALIASES the server's own return type rather than re-declaring the shape,
 * on purpose: the first cut of this hook hand-copied a `string | null` side, the
 * fetcher's `as Promise<T>` cast laundered it past the compiler, and every file
 * expansion handed Monaco an object. Aliasing the source of truth means a future
 * server-side change to a side's shape breaks THIS file at typecheck instead of
 * silently at runtime. (`import type` is erased at build — no server code or
 * node dependency reaches the client bundle.)
 *
 * The `truncated` flag has to survive to the renderer: a git-blob side is cut at
 * `runGitInSandbox`'s 256 KB stdout cap and a working-tree side at 2 MB, and
 * diffing a cut-off side against a whole one paints the file's untouched tail as
 * removed/added lines.
 */
export type MachineDiffSide = MachineDiffSideContent;

/**
 * One file's original/modified pair for a scope. A side is `null` when the file
 * doesn't exist there (an added file's original, a deleted file's modified).
 */
export type MachineDiffPairResponse =
  | { notApplicable: true }
  | {
      notApplicable: false;
      scope: MachineDiffScope;
      path: string;
      original: MachineDiffSide | null;
      modified: MachineDiffSide | null;
    };

/**
 * Every diff SWR key (lists AND per-file pairs) starts with this, so a refresh
 * can invalidate the whole surface with one keyed predicate — the expanded
 * cards' pair keys are separate SWR entries the pane doesn't own, and revalidating
 * only the lists would leave an open card serving pre-edit content forever
 * (both hooks set `revalidateOnFocus: false`).
 */
export const MACHINE_DIFF_KEY_PREFIX = '/api/machines/diff?';

/** True for any SWR key belonging to this surface — pass to SWR's global `mutate`. */
export function isMachineDiffKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(MACHINE_DIFF_KEY_PREFIX);
}

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
      ? MACHINE_DIFF_KEY_PREFIX +
        new URLSearchParams({ machineId, projectName, branchName, scope }).toString()
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
          // The rename SOURCE, so the route reads the 'original' side from the
          // pre-rename location instead of missing at the new path and
          // mis-showing the rename as an add.
          if (file.previousPath) params.set('previousPath', file.previousPath);
          return MACHINE_DIFF_KEY_PREFIX + params.toString();
        })()
      : null;

  const { data, error, isLoading } = useSWR<MachineDiffPairResponse>(key, fetcher, {
    revalidateOnFocus: false,
  });

  return { data, error: error as Error | undefined, isLoading };
}
