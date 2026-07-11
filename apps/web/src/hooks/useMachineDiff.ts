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

const MACHINE_DIFF_KEY_PREFIX = '/api/machines/diff?';

/**
 * The params identifying WHICH branch's diff a key addresses. Every key — list and
 * pair alike — starts with exactly these three, in this order.
 *
 * This is a single shared builder ON PURPOSE. `machineDiffKeyFilter` matches keys
 * by string prefix, so its correctness depends on that ordering; if the list and
 * pair hooks each spelled their own `URLSearchParams` literal, reordering one of
 * them would silently stop Refresh from matching it — the button would revalidate
 * nothing, with no spinner and no error, and present a stale diff as fresh. Routing
 * every key through one function makes that drift impossible rather than merely
 * unlikely.
 */
function branchScopedParams(machineId: string, projectName: string, branchName: string): URLSearchParams {
  return new URLSearchParams({ machineId, projectName, branchName });
}

/** SWR key for one branch+scope's changed-file list. */
export function machineDiffListKey(
  machineId: string,
  projectName: string,
  branchName: string,
  scope: MachineDiffScope,
): string {
  const params = branchScopedParams(machineId, projectName, branchName);
  params.set('scope', scope);
  return MACHINE_DIFF_KEY_PREFIX + params.toString();
}

/** SWR key for ONE file's diff pair within a branch+scope. */
export function machineDiffPairKey(
  machineId: string,
  projectName: string,
  branchName: string,
  scope: MachineDiffScope,
  file: MachineDiffFile,
): string {
  const params = branchScopedParams(machineId, projectName, branchName);
  params.set('scope', scope);
  params.set('path', file.path);
  params.set('status', file.status);
  // The rename SOURCE, so the route reads the 'original' side from the pre-rename
  // location instead of missing at the new path and mis-showing the rename as an add.
  if (file.previousPath) params.set('previousPath', file.previousPath);
  return MACHINE_DIFF_KEY_PREFIX + params.toString();
}

/**
 * An SWR `mutate` filter matching every key of ONE branch's diff — its scope
 * lists AND its expanded cards' per-file pairs.
 *
 * Scoped to the branch ON PURPOSE. A bare `/api/machines/diff?` prefix test would
 * also match OTHER machines' keys, and those are not hypothetical: Machine pages
 * are kept mounted across navigation in a bounded LRU (`TerminalKeepAliveHost`,
 * CSS-hidden, not unmounted), so a hidden Machine page's Diff tab still holds live
 * SWR subscriptions. Refreshing machine B would then re-fire machine A's list, its
 * merge-base probe, and every pair it had open — real sandbox `git` execs, billed,
 * against an unrelated and possibly stopped machine.
 *
 * The expanded cards' pair keys are separate SWR entries the pane doesn't own, so
 * refreshing only the lists would leave an open card serving pre-edit content
 * forever (both hooks set `revalidateOnFocus: false`) — hence a filter rather than
 * two `mutate()` calls.
 *
 * The trailing '&' is a real boundary, not decoration: without it the filter for
 * branch 'feat' would also swallow 'feature'. A value can never forge that
 * delimiter, because `URLSearchParams` percent-encodes any literal '&' or '=' it
 * contains.
 */
export function machineDiffKeyFilter(
  machineId: string,
  projectName: string,
  branchName: string,
): (key: unknown) => boolean {
  const branchPrefix = MACHINE_DIFF_KEY_PREFIX + branchScopedParams(machineId, projectName, branchName).toString() + '&';
  return (key: unknown): boolean => typeof key === 'string' && key.startsWith(branchPrefix);
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
    projectName && branchName && scope ? machineDiffListKey(machineId, projectName, branchName, scope) : null;

  const { data, error, isLoading, isValidating, mutate } = useSWR<MachineDiffFilesResponse>(key, fetcher, {
    revalidateOnFocus: false,
  });

  // `isValidating` (not `isLoading`) is what a refresh flips: the list already
  // has data, so SWR keeps serving it and only marks the refetch in flight.
  return { data, error: error as Error | undefined, isLoading, isValidating, mutate };
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
      ? machineDiffPairKey(machineId, projectName, branchName, scope, file)
      : null;

  const { data, error, isLoading } = useSWR<MachineDiffPairResponse>(key, fetcher, {
    revalidateOnFocus: false,
  });

  return { data, error: error as Error | undefined, isLoading };
}
