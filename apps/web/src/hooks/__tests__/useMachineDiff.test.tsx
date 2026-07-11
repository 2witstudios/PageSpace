import { describe, test, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';
import { assert } from '@/stores/__tests__/riteway';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

import {
  useMachineDiffFiles,
  useMachineDiffPair,
  machineDiffKeyFilter,
  machineDiffListKey,
  machineDiffPairKey,
} from '../useMachineDiff';

const ok = (body: unknown) => ({ ok: true, json: async () => body });

/** Fresh SWR cache per test, else a key hit in one test satisfies the next. */
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

/** The URL the hook actually requested, as parsed params. */
const requestedParams = (): URLSearchParams =>
  new URL(fetchWithAuth.mock.calls[0][0] as string, 'https://x').searchParams;

describe('useMachineDiffFiles', () => {
  beforeEach(() => vi.clearAllMocks());

  test('does not fetch until a branch and scope are selected', () => {
    renderHook(() => useMachineDiffFiles('m1', null, null, null), { wrapper });

    assert({
      given: 'no branch selected yet',
      should: 'issue no request — the tab fetches on-demand, never eagerly',
      actual: fetchWithAuth.mock.calls.length,
      expected: 0,
    });
  });

  test('requests the changed-file list for the selected branch and scope', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({ notApplicable: false, scope: 'branch', files: [{ path: 'src/a.ts', status: 'modified' }], truncated: false }),
    );

    const { result } = renderHook(() => useMachineDiffFiles('m1', 'repo', 'feat/x', 'branch'), { wrapper });
    await waitFor(() => assert({ given: 'a resolved fetch', should: 'have data', actual: result.current.data !== undefined, expected: true }));

    assert({
      given: 'a branch + scope selected',
      should: 'GET the diff route with machineId/projectName/branchName/scope, and surface the file list',
      actual: {
        params: Object.fromEntries(requestedParams()),
        files: result.current.data && !result.current.data.notApplicable ? result.current.data.files : null,
      },
      expected: {
        params: { machineId: 'm1', projectName: 'repo', branchName: 'feat/x', scope: 'branch' },
        files: [{ path: 'src/a.ts', status: 'modified' }],
      },
    });
  });

  test('surfaces the route\'s explicit notApplicable answer rather than flattening it to empty', async () => {
    fetchWithAuth.mockResolvedValue(ok({ notApplicable: true }));

    const { result } = renderHook(() => useMachineDiffFiles('m1', 'repo', 'main', 'committed'), { wrapper });
    await waitFor(() => assert({ given: 'a resolved fetch', should: 'have data', actual: result.current.data !== undefined, expected: true }));

    assert({
      given: 'the main branch, where committed/branch scopes are meaningless',
      should: 'pass notApplicable through — the toggle depends on this flag, not on an empty file list',
      actual: result.current.data,
      expected: { notApplicable: true },
    });
  });

  test('raises the route error message', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, json: async () => ({ error: 'Branch machine not_found' }) });

    const { result } = renderHook(() => useMachineDiffFiles('m1', 'repo', 'feat/x', 'uncommitted'), { wrapper });
    await waitFor(() => assert({ given: 'a failed fetch', should: 'have error', actual: result.current.error !== undefined, expected: true }));

    assert({
      given: 'the route returning a non-2xx with an error body',
      should: 'throw that message so the UI shows the real failure, not an empty diff',
      actual: result.current.error?.message,
      expected: 'Branch machine not_found',
    });
  });
});

describe('useMachineDiffPair', () => {
  const file = { path: 'src/a.ts', status: 'modified' as const };

  beforeEach(() => vi.clearAllMocks());

  test('does not fetch while the card is collapsed', () => {
    renderHook(() => useMachineDiffPair('m1', 'repo', 'feat/x', 'uncommitted', file, false), { wrapper });

    assert({
      given: 'a collapsed file card (enabled=false)',
      should: 'issue no request — a 200-file scope must cost zero content fetches until a card is opened',
      actual: fetchWithAuth.mock.calls.length,
      expected: 0,
    });
  });

  test('returns each side as { content, truncated } — the shape the route actually ships', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({
        notApplicable: false,
        scope: 'uncommitted',
        path: 'src/a.ts',
        original: { content: 'old', truncated: false },
        modified: { content: 'new', truncated: true },
      }),
    );

    const { result } = renderHook(() => useMachineDiffPair('m1', 'repo', 'feat/x', 'uncommitted', file, true), { wrapper });
    await waitFor(() => assert({ given: 'a resolved fetch', should: 'have data', actual: result.current.data !== undefined, expected: true }));

    assert({
      given: 'the per-file pair form of the diff route',
      should: 'keep each side\'s content AND its truncated flag — a bare string would drop the cut-off warning',
      actual: result.current.data,
      expected: {
        notApplicable: false,
        scope: 'uncommitted',
        path: 'src/a.ts',
        original: { content: 'old', truncated: false },
        modified: { content: 'new', truncated: true },
      },
    });
  });

  test('passes null sides through for an added file (no original)', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({ notApplicable: false, scope: 'uncommitted', path: 'new.ts', original: null, modified: { content: 'brand new', truncated: false } }),
    );
    const added = { path: 'new.ts', status: 'added' as const };

    const { result } = renderHook(() => useMachineDiffPair('m1', 'repo', 'feat/x', 'uncommitted', added, true), { wrapper });
    await waitFor(() => assert({ given: 'a resolved fetch', should: 'have data', actual: result.current.data !== undefined, expected: true }));

    assert({
      given: 'an added file, which has no original side',
      should: 'keep the null side as null so the renderer diffs against an empty original',
      actual: result.current.data && !result.current.data.notApplicable ? result.current.data.original : 'missing',
      expected: null,
    });
  });

  test('threads status and previousPath so a rename reads its pre-rename original', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({ notApplicable: false, scope: 'branch', path: 'src/new.ts', original: { content: 'a', truncated: false }, modified: { content: 'b', truncated: false } }),
    );
    const renamed = { path: 'src/new.ts', status: 'renamed' as const, previousPath: 'src/old.ts' };

    renderHook(() => useMachineDiffPair('m1', 'repo', 'feat/x', 'branch', renamed, true), { wrapper });
    await waitFor(() => assert({ given: 'a fired fetch', should: 'have been called', actual: fetchWithAuth.mock.calls.length, expected: 1 }));

    assert({
      given: 'a renamed file from the changed-file list',
      should: 'send path, status and previousPath — without previousPath the route resolves no original and mis-shows the rename as an add',
      actual: Object.fromEntries(requestedParams()),
      expected: {
        machineId: 'm1',
        projectName: 'repo',
        branchName: 'feat/x',
        scope: 'branch',
        path: 'src/new.ts',
        status: 'renamed',
        previousPath: 'src/old.ts',
      },
    });
  });

  test('omits previousPath for a file that has none', async () => {
    fetchWithAuth.mockResolvedValue(
      ok({ notApplicable: false, scope: 'uncommitted', path: 'src/a.ts', original: null, modified: null }),
    );

    renderHook(() => useMachineDiffPair('m1', 'repo', 'feat/x', 'uncommitted', file, true), { wrapper });
    await waitFor(() => assert({ given: 'a fired fetch', should: 'have been called', actual: fetchWithAuth.mock.calls.length, expected: 1 }));

    assert({
      given: 'a plain modified file',
      should: 'not send an empty previousPath param',
      actual: requestedParams().has('previousPath'),
      expected: false,
    });
  });
});

describe('machineDiffKeyFilter', () => {
  const file = { path: 'src/a.ts', status: 'modified' as const };

  test("matches the REAL keys the hooks build for one branch — lists and open file pairs", () => {
    const matches = machineDiffKeyFilter('m1', 'repo', 'feat/x');

    // Built with the SAME exported builders the hooks use, not hand-written
    // look-alikes: the filter is a string-prefix test, so its correctness is
    // coupled to the key's param ORDER. A hand-rolled expectation would keep
    // passing after a reorder while Refresh silently matched nothing in the app.
    assert({
      given: "the refresh filter for one branch, and the actual keys the hooks produce for it",
      should: 'match its scope lists AND its per-file pair keys — an open card owns a separate key that must revalidate too',
      actual: {
        uncommittedList: matches(machineDiffListKey('m1', 'repo', 'feat/x', 'uncommitted')),
        committedList: matches(machineDiffListKey('m1', 'repo', 'feat/x', 'committed')),
        pair: matches(machineDiffPairKey('m1', 'repo', 'feat/x', 'branch', file)),
        renamedPair: matches(
          machineDiffPairKey('m1', 'repo', 'feat/x', 'branch', { ...file, status: 'renamed', previousPath: 'src/old.ts' }),
        ),
      },
      expected: { uncommittedList: true, committedList: true, pair: true, renamedPair: true },
    });
  });

  test('does NOT match another machine, project, or branch', () => {
    const matches = machineDiffKeyFilter('m1', 'repo', 'feat/x');

    // Machine pages stay mounted in a keep-alive LRU, so a machine-agnostic filter
    // would re-fire a hidden machine's git execs (list + merge-base + every open
    // pair) on every refresh — against a machine the user isn't even looking at.
    assert({
      given: 'SWR keys belonging to other machines/projects/branches, and unrelated routes',
      should: 'reject them all — a refresh must never trigger sandbox git on a machine the user is not viewing',
      actual: {
        otherMachine: matches(machineDiffListKey('m2', 'repo', 'feat/x', 'uncommitted')),
        otherProject: matches(machineDiffListKey('m1', 'other', 'feat/x', 'uncommitted')),
        otherBranch: matches(machineDiffListKey('m1', 'repo', 'feat/y', 'uncommitted')),
        otherMachinePair: matches(machineDiffPairKey('m2', 'repo', 'feat/x', 'uncommitted', file)),
        otherRoute: matches('/api/machines/files?machineId=m1'),
        nonString: matches(null),
      },
      expected: {
        otherMachine: false,
        otherProject: false,
        otherBranch: false,
        otherMachinePair: false,
        otherRoute: false,
        nonString: false,
      },
    });
  });

  test('a branch name that PREFIXES another does not match it', () => {
    // The filter is a string prefix test, so the trailing '&' after branchName is
    // load-bearing: without it, the filter for 'feat' would also swallow 'feature'.
    assert({
      given: "the filter for branch 'feat' and a real key for branch 'feature'",
      should: "not match — 'feat' must not swallow 'feature'",
      actual: machineDiffKeyFilter('m1', 'repo', 'feat')(machineDiffListKey('m1', 'repo', 'feature', 'uncommitted')),
      expected: false,
    });
  });

  test('a branch name containing & or = cannot forge the key boundary', () => {
    // URLSearchParams percent-encodes them, so a value can never look like a
    // delimiter and cross-match another branch's keys.
    const matches = machineDiffKeyFilter('m1', 'repo', 'feat&branchName=other');

    assert({
      given: 'a branch name carrying the key format\'s own delimiters',
      should: 'still match only its own keys, and not the branch it tries to impersonate',
      actual: {
        own: matches(machineDiffListKey('m1', 'repo', 'feat&branchName=other', 'uncommitted')),
        impersonated: matches(machineDiffListKey('m1', 'repo', 'other', 'uncommitted')),
      },
      expected: { own: true, impersonated: false },
    });
  });
});
