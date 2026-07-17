import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({
  toast: toastMocks,
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import MachineFileTree from './MachineFileTree';
import type { FilesScope } from '../tabs/files-scope';

/**
 * Fake checkout served by the mocked /api/machines/files. Root order is
 * deliberately unsorted (file-first, reverse-alphabetical) to prove the
 * component sorts directories first and alphabetically within each type,
 * rather than echoing server order.
 */
const FAKE_FS: Record<string, { name: string; type: 'file' | 'directory' }[]> = {
  '': [
    { name: 'zeta.md', type: 'file' },
    { name: 'README.md', type: 'file' },
    { name: 'src', type: 'directory' },
  ],
  src: [
    { name: 'components', type: 'directory' },
    { name: 'index.ts', type: 'file' },
  ],
  'src/components': [{ name: 'Button.tsx', type: 'file' }],
};

const requestedPath = (url: string): string =>
  new URL(url, 'http://test').searchParams.get('path') ?? '';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A promise the test resolves by hand, to hold one directory's listing in flight. */
const deferredResponse = () => {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** Serve FAKE_FS; per-path overrides let a test hold one directory pending or failing. */
const cannedFetch = (overrides: Record<string, () => Promise<Response>> = {}) =>
  vi.mocked(fetchWithAuth).mockImplementation(async (...args: unknown[]) => {
    const path = requestedPath(String(args[0]));
    const override = overrides[path];
    if (override) return override();
    const entries = FAKE_FS[path];
    if (!entries) return jsonResponse({ error: 'not_found' }, 404);
    return jsonResponse({ entries });
  });

// Excludes mutation calls: a POST/PATCH/DELETE to `/api/machines/files` has no
// `path` query param at all, so it would otherwise be miscounted as a listing
// of the root ('').
const listCallsFor = (path: string): number =>
  vi.mocked(fetchWithAuth).mock.calls.filter((call) => {
    const init = (call[1] ?? {}) as RequestInit | undefined;
    const method = typeof init?.method === 'string' ? init.method : 'GET';
    return method === 'GET' && requestedPath(String(call[0])) === path;
  }).length;

const BRANCH_SCOPE: FilesScope = { kind: 'branch', projectName: 'my-repo', branchName: 'main' };

/** One recorded mutation (POST/PATCH/DELETE) call, with its body already parsed. */
interface MutationCall {
  method: string | undefined;
  body: unknown;
}

/**
 * Serves listings from FAKE_FS same as `cannedFetch`, but routes any
 * non-GET call to `mutationResponse` and records it — used by the
 * context-menu/mutation tests below, which need to inspect the request the
 * tree issued rather than only what it rendered afterwards.
 */
const cannedFetchWithMutation = (
  mutationCalls: MutationCall[],
  mutationResponse: () => Response | Promise<Response>,
) =>
  vi.mocked(fetchWithAuth).mockImplementation(async (...args: unknown[]) => {
    const init = (args[1] ?? {}) as RequestInit;
    const method = typeof init.method === 'string' ? init.method : undefined;
    if (method && method !== 'GET') {
      mutationCalls.push({ method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return mutationResponse();
    }
    const path = requestedPath(String(args[0]));
    const entries = FAKE_FS[path];
    if (!entries) return jsonResponse({ error: 'not_found' }, 404);
    return jsonResponse({ entries });
  });

const renderTree = (props: Partial<Parameters<typeof MachineFileTree>[0]> = {}) =>
  render(<MachineFileTree machineId="machine-1" scope={BRANCH_SCOPE} {...props} />);

const expandFolder = async (name: string) => {
  const label = await waitFor(() => screen.getByText(name));
  await userEvent.click(label);
};

/** All row labels currently rendered, in document order. */
const rowLabels = (): (string | null)[] =>
  Array.from(
    document.querySelectorAll('[data-testid="file-tree-dir-toggle"], [data-testid="file-tree-file"]'),
  ).map((el) => el.textContent);

describe('MachineFileTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastMocks.error.mockClear();
    toastMocks.success.mockClear();
    cannedFetch();
  });

  test('renders the checkout root listing on mount', async () => {
    renderTree();

    await waitFor(() => screen.getByText('README.md'));

    assert({
      given: 'a mounted tree',
      should: 'show the root directory entries returned by the files API',
      actual: [screen.getByText('src').textContent, screen.getByText('README.md').textContent],
      expected: ['src', 'README.md'],
    });
  });

  test('root scope lists without projectName/branchName params', async () => {
    renderTree({ scope: { kind: 'root' } });

    await waitFor(() => screen.getByText('README.md'));
    const call = vi.mocked(fetchWithAuth).mock.calls[0];
    const url = new URL(String(call[0]), 'http://test');

    assert({
      given: 'a tree mounted with root scope',
      should: "list the files route with no projectName/branchName — just machineId",
      actual: { projectName: url.searchParams.get('projectName'), branchName: url.searchParams.get('branchName') },
      expected: { projectName: null, branchName: null },
    });
  });

  test('sorts directories first, then files alphabetically, regardless of server order', async () => {
    renderTree();

    await waitFor(() => screen.getByText('README.md'));

    assert({
      given: 'a root listing the server returned unsorted (zeta.md, README.md, src)',
      should: 'render the directory first, then files in alphabetical order',
      actual: rowLabels(),
      expected: ['src', 'README.md', 'zeta.md'],
    });
  });

  test('does not eagerly fetch subdirectories on mount', async () => {
    renderTree();

    await waitFor(() => screen.getByText('src'));

    assert({
      given: 'a freshly mounted tree whose root contains a directory',
      should: 'fetch only the root listing — no whole-tree walk',
      actual: { totalFetches: vi.mocked(fetchWithAuth).mock.calls.length, srcFetches: listCallsFor('src') },
      expected: { totalFetches: 1, srcFetches: 0 },
    });
  });

  test('expanding a directory lazily fetches that directory, and only then', async () => {
    renderTree();

    await expandFolder('src');
    await waitFor(() => screen.getByText('index.ts'));

    assert({
      given: 'a directory expanded by clicking its row',
      should: "fetch that directory's listing and render its children",
      actual: { srcFetches: listCallsFor('src'), child: screen.getByText('index.ts').textContent },
      expected: { srcFetches: 1, child: 'index.ts' },
    });
  });

  test('collapse then re-expand serves the cached listing without refetching', async () => {
    renderTree();

    await expandFolder('src');
    await waitFor(() => screen.getByText('index.ts'));
    await userEvent.click(screen.getByText('src')); // collapse
    const collapsedChild = screen.queryByText('index.ts');
    await userEvent.click(screen.getByText('src')); // re-expand
    await waitFor(() => screen.getByText('index.ts'));

    assert({
      given: 'a directory expanded, collapsed, and expanded again',
      should: 'hide children while collapsed and re-show them from cache with no second fetch',
      actual: { collapsedChild, srcFetches: listCallsFor('src') },
      expected: { collapsedChild: null, srcFetches: 1 },
    });
  });

  test('collapsing and re-expanding while the listing is in flight does not duplicate the fetch', async () => {
    const deferred = deferredResponse();
    cannedFetch({ src: () => deferred.promise });
    renderTree();

    await expandFolder('src'); // starts the fetch, still pending
    await userEvent.click(screen.getByText('src')); // collapse mid-flight
    await userEvent.click(screen.getByText('src')); // re-expand mid-flight
    deferred.resolve(jsonResponse({ entries: FAKE_FS['src'] }));
    await waitFor(() => screen.getByText('index.ts'));

    assert({
      given: 'a directory toggled closed and open again while its first listing is still loading',
      should: 'issue exactly one fetch and render the children once it resolves',
      actual: { srcFetches: listCallsFor('src'), child: screen.getByText('index.ts').textContent },
      expected: { srcFetches: 1, child: 'index.ts' },
    });
  });

  test('preserves nested expansion state across a parent collapse', async () => {
    renderTree();

    await expandFolder('src');
    await expandFolder('components');
    await waitFor(() => screen.getByText('Button.tsx'));
    await userEvent.click(screen.getByText('src')); // collapse parent
    await userEvent.click(screen.getByText('src')); // re-expand parent
    await waitFor(() => screen.getByText('Button.tsx'));

    assert({
      given: 'a nested directory expanded, then its parent collapsed and re-expanded',
      should: 'still show the nested directory open, from cache, without refetching it',
      actual: {
        nestedChild: screen.getByText('Button.tsx').textContent,
        componentsFetches: listCallsFor('src/components'),
      },
      expected: { nestedChild: 'Button.tsx', componentsFetches: 1 },
    });
  });

  test('changing the branch identity remounts the tree: cache dropped, expansion reset', async () => {
    const { rerender } = renderTree();
    await expandFolder('src');
    await waitFor(() => screen.getByText('index.ts'));

    rerender(
      <MachineFileTree
        machineId="machine-1"
        scope={{ kind: 'branch', projectName: 'my-repo', branchName: 'dev' }}
      />,
    );
    await waitFor(() => {
      if (listCallsFor('') < 2) throw new Error('new branch root listing not fetched yet');
    });
    const staleChild = screen.queryByText('index.ts');
    await expandFolder('src'); // re-expand on the new branch — the old cache must be gone
    await waitFor(() => screen.getByText('index.ts'));

    assert({
      given: 'the branchName prop changed after a directory was expanded',
      should: 'refetch the root, reset expansion, and refetch a re-expanded directory (cache dropped)',
      actual: { rootFetches: listCallsFor(''), staleChild, srcFetches: listCallsFor('src') },
      expected: { rootFetches: 2, staleChild: null, srcFetches: 2 },
    });
  });

  test('the header refresh drops the cache and reloads every visible directory', async () => {
    renderTree();
    await expandFolder('src');
    await waitFor(() => screen.getByText('index.ts'));

    await userEvent.click(screen.getByTitle('Refresh files'));
    await waitFor(() => {
      if (listCallsFor('src') < 2) throw new Error('src not refetched yet');
    });
    await waitFor(() => screen.getByText('index.ts'));

    assert({
      given: 'refresh clicked while root and one expanded directory are visible',
      should: 'refetch both listings (the working tree is live) and keep the directory expanded',
      actual: { rootFetches: listCallsFor(''), srcFetches: listCallsFor('src'), child: screen.getByText('index.ts').textContent },
      expected: { rootFetches: 2, srcFetches: 2, child: 'index.ts' },
    });
  });

  test('clicking a nested file calls onSelectFile with the full checkout-relative path', async () => {
    const onSelectFile = vi.fn();
    renderTree({ onSelectFile });

    await expandFolder('src');
    await expandFolder('components');
    const file = await waitFor(() => screen.getByText('Button.tsx'));
    await userEvent.click(file);

    assert({
      given: 'a file two directory levels deep clicked',
      should: 'report its path relative to the checkout root, not just its name',
      actual: onSelectFile.mock.calls[0]?.[0],
      expected: 'src/components/Button.tsx',
    });
  });

  test('highlights the selected file row', async () => {
    renderTree({ onSelectFile: vi.fn(), selectedPath: 'README.md' });

    const file = await waitFor(() => screen.getByText('README.md'));

    assert({
      given: 'a selectedPath matching a rendered file',
      should: 'mark that row as current',
      actual: file.closest('button')?.getAttribute('aria-current'),
      expected: 'true',
    });
  });

  test('shows a per-directory loading state while a listing is in flight', async () => {
    cannedFetch({ src: () => new Promise<Response>(() => undefined) }); // never resolves
    renderTree();

    await expandFolder('src');

    assert({
      given: 'an expanded directory whose listing has not resolved yet',
      should: 'render the shared sidebar loading row under that directory',
      actual: screen.getByText('Loading files…').textContent,
      expected: 'Loading files…',
    });
  });

  test('shows a per-directory error state when a listing fails', async () => {
    cannedFetch({ src: async () => jsonResponse({ error: 'exec failed' }, 502) });
    renderTree();

    await expandFolder('src');
    const error = await waitFor(() => screen.getByText('exec failed'));

    assert({
      given: 'a directory whose listing request failed',
      should: "surface the API's error message under that directory",
      actual: error.textContent,
      expected: 'exec failed',
    });
  });

  test('a 200 response without an entries array is surfaced as an error, not a crash', async () => {
    cannedFetch({ src: async () => jsonResponse({ unexpected: true }) });
    renderTree();

    await expandFolder('src');
    const error = await waitFor(() => screen.getByText('Malformed file listing response'));

    assert({
      given: 'a successful response whose body has no entries array',
      should: 'show a meaningful error row for that directory',
      actual: error.textContent,
      expected: 'Malformed file listing response',
    });
  });

  test('retry after an error refetches and renders the listing', async () => {
    let failed = false;
    cannedFetch({
      src: async () => {
        if (!failed) {
          failed = true;
          return jsonResponse({ error: 'exec failed' }, 502);
        }
        return jsonResponse({ entries: FAKE_FS['src'] });
      },
    });
    renderTree();

    await expandFolder('src');
    await waitFor(() => screen.getByText('exec failed'));
    await userEvent.click(screen.getByText('Retry'));
    await waitFor(() => screen.getByText('index.ts'));

    assert({
      given: 'a failed directory listing retried via its Retry button',
      should: 'fetch again (errors are not cached) and render the children',
      actual: { srcFetches: listCallsFor('src'), child: screen.getByText('index.ts').textContent },
      expected: { srcFetches: 2, child: 'index.ts' },
    });
  });

  test('an empty directory shows an explicit empty row', async () => {
    cannedFetch({ src: async () => jsonResponse({ entries: [] }) });
    renderTree();

    await expandFolder('src');
    const empty = await waitFor(() => screen.getByText('Empty folder'));

    assert({
      given: 'an expanded directory with no entries',
      should: 'render an explicit empty row instead of nothing',
      actual: empty.textContent,
      expected: 'Empty folder',
    });
  });

  describe('context menu operations', () => {
    test('New Folder via a directory context menu POSTs a scoped, confined path and re-lists the parent once', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ ok: true }));
      renderTree();

      await expandFolder('src');
      await waitFor(() => screen.getByText('index.ts'));
      const srcFetchesBefore = listCallsFor('src');

      fireEvent.contextMenu(screen.getByText('src'));
      await userEvent.click(await waitFor(() => screen.getByText('New Folder')));
      await userEvent.type(screen.getByLabelText('Name'), 'newdir');
      await userEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        if (listCallsFor('src') <= srcFetchesBefore) throw new Error('src not relisted yet');
      });

      assert({
        given: "New Folder chosen from the 'src' directory's context menu, named 'newdir'",
        should: "POST the confined child path with the branch scope fields, then re-list 'src' exactly once",
        actual: {
          mutation: calls[0],
          srcRelistCount: listCallsFor('src') - srcFetchesBefore,
        },
        expected: {
          mutation: {
            method: 'POST',
            body: {
              machineId: 'machine-1',
              projectName: 'my-repo',
              branchName: 'main',
              path: 'src/newdir',
              kind: 'directory',
            },
          },
          srcRelistCount: 1,
        },
      });
    });

    test('Rename posts a same-parent PATCH move and drops the renamed directory\'s stale descendant cache', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ ok: true }));
      renderTree();

      await expandFolder('src');
      await expandFolder('components');
      await waitFor(() => screen.getByText('Button.tsx'));
      const componentsFetchesBefore = listCallsFor('src/components');

      fireEvent.contextMenu(screen.getByText('components'));
      await userEvent.click(await waitFor(() => screen.getByText('Rename')));
      const input = await waitFor(() => screen.getByLabelText('Name')) as HTMLInputElement;
      await userEvent.clear(input);
      await userEvent.type(input, 'ui');
      await userEvent.click(screen.getByText('Save'));

      // 'components' stays expanded across the rename, so dropping its cache
      // entry alone (without a manual toggle) is what proves the descendant
      // cache was actually invalidated, not just the parent.
      await waitFor(() => {
        if (listCallsFor('src/components') <= componentsFetchesBefore) {
          throw new Error('renamed directory\'s stale cache not dropped yet');
        }
      });

      assert({
        given: "Rename chosen from the 'components' directory's context menu, renamed to 'ui'",
        should: 'PATCH a move with fromPath/toPath in the same parent, and refetch the old path once (stale cache dropped)',
        actual: {
          mutation: calls[0],
          staleCacheDropped: listCallsFor('src/components') - componentsFetchesBefore,
        },
        expected: {
          mutation: {
            method: 'PATCH',
            body: {
              machineId: 'machine-1',
              projectName: 'my-repo',
              branchName: 'main',
              op: 'move',
              fromPath: 'src/components',
              toPath: 'src/ui',
            },
          },
          staleCacheDropped: 1,
        },
      });
    });

    test('Delete confirm fires DELETE and re-lists the parent', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ ok: true }));
      renderTree();

      await expandFolder('src');
      await waitFor(() => screen.getByText('index.ts'));
      const srcFetchesBefore = listCallsFor('src');

      fireEvent.contextMenu(screen.getByText('index.ts'));
      await userEvent.click(await waitFor(() => screen.getByText('Delete')));
      await waitFor(() => screen.getByText('Delete "src/index.ts"?', { exact: false }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        if (listCallsFor('src') <= srcFetchesBefore) throw new Error('src not relisted yet');
      });

      assert({
        given: "Delete confirmed from 'src/index.ts'’s context menu",
        should: 'DELETE the scoped path and re-list its parent once',
        actual: {
          mutation: calls[0],
          srcRelistCount: listCallsFor('src') - srcFetchesBefore,
        },
        expected: {
          mutation: {
            method: 'DELETE',
            body: { machineId: 'machine-1', projectName: 'my-repo', branchName: 'main', path: 'src/index.ts' },
          },
          srcRelistCount: 1,
        },
      });
    });

    test('a 409 from a mutation toasts a friendly message and never re-lists or renders a row error', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ error: 'already_exists' }, 409));
      renderTree();
      await waitFor(() => screen.getByText('README.md'));
      const rootFetchesBefore = listCallsFor('');

      await userEvent.click(screen.getByTitle('New file'));
      await userEvent.type(screen.getByLabelText('Name'), 'zeta.md');
      await userEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        if (toastMocks.error.mock.calls.length === 0) throw new Error('toast not fired yet');
      });

      assert({
        given: 'a create-file mutation that comes back 409',
        should: 'toast a friendly "already has that name" message, issue no re-list, and never render a red tree row',
        actual: {
          toastMessage: toastMocks.error.mock.calls[0]?.[0],
          rootRelistCount: listCallsFor('') - rootFetchesBefore,
          rowError: screen.queryByTestId('file-tree-error'),
        },
        expected: {
          toastMessage: 'Something already has that name',
          rootRelistCount: 0,
          rowError: null,
        },
      });
    });

    test('deleting the currently open file reports it via onPathRemoved', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ ok: true }));
      const onPathRemoved = vi.fn();
      renderTree({ scope: { kind: 'root' }, selectedPath: 'README.md', onPathRemoved });

      await waitFor(() => screen.getByText('README.md'));

      fireEvent.contextMenu(screen.getByText('README.md'));
      await userEvent.click(await waitFor(() => screen.getByText('Delete')));
      await userEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Delete' })));

      await waitFor(() => {
        if (onPathRemoved.mock.calls.length === 0) throw new Error('onPathRemoved not called yet');
      });

      assert({
        given: 'the currently open file (selectedPath) deleted via its context menu',
        should: 'report the deleted path through onPathRemoved so the parent can clear it',
        actual: onPathRemoved.mock.calls[0]?.[0],
        expected: 'README.md',
      });
    });
  });

  describe('move / copy / upload / download operations', () => {
    test('Move posts a PATCH with the entered destination, re-lists both parents, and drops the moved directory\'s own stale cache', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ ok: true }));
      const onPathRenamed = vi.fn();
      renderTree({ onPathRenamed });

      await expandFolder('src');
      await expandFolder('components');
      await waitFor(() => screen.getByText('Button.tsx'));
      const srcFetchesBefore = listCallsFor('src');
      const rootFetchesBefore = listCallsFor('');
      const componentsFetchesBefore = listCallsFor('src/components');

      fireEvent.contextMenu(screen.getByText('components'));
      await userEvent.click(await waitFor(() => screen.getByText('Move…')));
      const input = (await waitFor(() => screen.getByLabelText('Destination path'))) as HTMLInputElement;
      await userEvent.clear(input);
      await userEvent.type(input, 'components');
      await userEvent.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => {
        if (onPathRenamed.mock.calls.length === 0) throw new Error('onPathRenamed not called yet');
      });

      assert({
        given: "Move chosen from the 'src/components' directory's context menu, destination entered as 'components' (root)",
        should:
          "PATCH op:'move' with the exact entered toPath, re-list both the source and destination parent once, drop the moved directory's own stale cache (same mechanism as rename), and report the move via onPathRenamed",
        actual: {
          mutation: calls[0],
          srcRelistCount: listCallsFor('src') - srcFetchesBefore,
          rootRelistCount: listCallsFor('') - rootFetchesBefore,
          componentsStaleCacheDropped: listCallsFor('src/components') - componentsFetchesBefore,
          renamedArgs: onPathRenamed.mock.calls[0],
        },
        expected: {
          mutation: {
            method: 'PATCH',
            body: {
              machineId: 'machine-1',
              projectName: 'my-repo',
              branchName: 'main',
              op: 'move',
              fromPath: 'src/components',
              toPath: 'components',
            },
          },
          srcRelistCount: 1,
          rootRelistCount: 1,
          componentsStaleCacheDropped: 1,
          renamedArgs: ['src/components', 'components'],
        },
      });
    });

    test('Copy posts a PATCH with the entered destination, re-lists both parents, and never touches the open-file selection', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ ok: true }));
      const onPathRenamed = vi.fn();
      renderTree({ onPathRenamed });

      await expandFolder('src');
      await waitFor(() => screen.getByText('index.ts'));
      const srcFetchesBefore = listCallsFor('src');
      const rootFetchesBefore = listCallsFor('');

      fireEvent.contextMenu(screen.getByText('index.ts'));
      await userEvent.click(await waitFor(() => screen.getByText('Copy…')));
      const input = (await waitFor(() => screen.getByLabelText('Destination path'))) as HTMLInputElement;
      await userEvent.clear(input);
      await userEvent.type(input, 'index-copy.ts');
      await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

      await waitFor(() => {
        if (listCallsFor('') <= rootFetchesBefore) throw new Error('destination parent not relisted yet');
      });

      // 'src/index.ts' is a FILE — it never had a cache entry of its own (only
      // directory listings are cached), so "no source cache drop of the old
      // path" is provable simply by there being nothing at that key to begin
      // with, unlike Move's directory case above.
      assert({
        given: "Copy chosen from 'src/index.ts'’s context menu, destination entered as 'index-copy.ts' (root)",
        should:
          "PATCH op:'copy' with the exact entered toPath, re-list both the source and destination parent once, and never call onPathRenamed (copy doesn't touch the open file)",
        actual: {
          mutation: calls[0],
          srcRelistCount: listCallsFor('src') - srcFetchesBefore,
          rootRelistCount: listCallsFor('') - rootFetchesBefore,
          renamedCalls: onPathRenamed.mock.calls.length,
        },
        expected: {
          mutation: {
            method: 'PATCH',
            body: {
              machineId: 'machine-1',
              projectName: 'my-repo',
              branchName: 'main',
              op: 'copy',
              fromPath: 'src/index.ts',
              toPath: 'index-copy.ts',
            },
          },
          srcRelistCount: 1,
          rootRelistCount: 1,
          renamedCalls: 0,
        },
      });
    });

    test('a 409 from a move toasts a friendly message and issues no re-list of either parent', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ error: 'already_exists' }, 409));
      renderTree();

      await expandFolder('src');
      await waitFor(() => screen.getByText('index.ts'));
      const srcFetchesBefore = listCallsFor('src');
      const rootFetchesBefore = listCallsFor('');

      fireEvent.contextMenu(screen.getByText('index.ts'));
      await userEvent.click(await waitFor(() => screen.getByText('Move…')));
      const input = (await waitFor(() => screen.getByLabelText('Destination path'))) as HTMLInputElement;
      await userEvent.clear(input);
      await userEvent.type(input, 'zeta.md');
      await userEvent.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => {
        if (toastMocks.error.mock.calls.length === 0) throw new Error('toast not fired yet');
      });

      assert({
        given: 'a move whose destination already has something there (409)',
        should: 'toast the friendly "already has that name" message and issue no re-list of either parent',
        actual: {
          toastMessage: toastMocks.error.mock.calls[0]?.[0],
          srcRelistCount: listCallsFor('src') - srcFetchesBefore,
          rootRelistCount: listCallsFor('') - rootFetchesBefore,
        },
        expected: {
          toastMessage: 'Something already has that name',
          srcRelistCount: 0,
          rootRelistCount: 0,
        },
      });
    });

    test('a 404 from a move (source vanished) toasts the route\'s own error and re-lists only the now-stale source parent', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ error: 'The item to move could not be found', reason: 'not_found' }, 404));
      renderTree();

      await expandFolder('src');
      await waitFor(() => screen.getByText('index.ts'));
      const srcFetchesBefore = listCallsFor('src');
      const rootFetchesBefore = listCallsFor('');

      fireEvent.contextMenu(screen.getByText('index.ts'));
      await userEvent.click(await waitFor(() => screen.getByText('Move…')));
      const input = (await waitFor(() => screen.getByLabelText('Destination path'))) as HTMLInputElement;
      await userEvent.clear(input);
      await userEvent.type(input, 'moved.ts');
      await userEvent.click(screen.getByRole('button', { name: 'Move' }));

      await waitFor(() => {
        if (listCallsFor('src') <= srcFetchesBefore) throw new Error('src not relisted yet');
      });

      assert({
        given: "a move whose source has vanished out from under it (404 'not_found')",
        should: "toast the route's own error and re-list only the stale source parent, never the destination parent",
        actual: {
          toastMessage: toastMocks.error.mock.calls[0]?.[0],
          srcRelistCount: listCallsFor('src') - srcFetchesBefore,
          rootRelistCount: listCallsFor('') - rootFetchesBefore,
        },
        expected: {
          toastMessage: 'The item to move could not be found',
          srcRelistCount: 1,
          rootRelistCount: 0,
        },
      });
    });

    test('Upload files… posts each selected file sequentially as base64 and re-lists the target directory exactly once', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ ok: true }));
      renderTree({ scope: { kind: 'root' } });

      await waitFor(() => screen.getByText('README.md'));
      const rootFetchesBefore = listCallsFor('');

      const fileA = new File(['hello'], 'a.txt', { type: 'text/plain' });
      const fileB = new File(['world'], 'b.txt', { type: 'text/plain' });
      const input = screen.getByTestId('file-tree-upload-input') as HTMLInputElement;

      await userEvent.click(screen.getByTitle('Upload files'));
      await userEvent.upload(input, [fileA, fileB]);

      await waitFor(() => {
        if (calls.length < 2) throw new Error('both uploads not posted yet');
      });
      await waitFor(() => {
        if (listCallsFor('') <= rootFetchesBefore) throw new Error('target dir not relisted yet');
      });

      assert({
        given: 'two files selected via "Upload files…" at the scope root',
        should: 'POST each sequentially as base64-encoded content at the root, then re-list the root exactly once for the whole batch',
        actual: {
          uploads: calls.map((c) => {
            const body = c.body as Record<string, unknown>;
            return {
              method: c.method,
              path: body.path,
              kind: body.kind,
              encoding: body.encoding,
              content: Buffer.from(body.content as string, 'base64').toString('utf8'),
            };
          }),
          rootRelistCount: listCallsFor('') - rootFetchesBefore,
        },
        expected: {
          uploads: [
            { method: 'POST', path: 'a.txt', kind: 'file', encoding: 'base64', content: 'hello' },
            { method: 'POST', path: 'b.txt', kind: 'file', encoding: 'base64', content: 'world' },
          ],
          rootRelistCount: 1,
        },
      });
    });

    test('a file over the 10 MiB client cap is skipped with a toast and never POSTed, without blocking the rest of the batch', async () => {
      const calls: MutationCall[] = [];
      cannedFetchWithMutation(calls, () => jsonResponse({ ok: true }));
      renderTree({ scope: { kind: 'root' } });

      await waitFor(() => screen.getByText('README.md'));
      const rootFetchesBefore = listCallsFor('');

      const bigFile = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.bin', { type: 'application/octet-stream' });
      const okFile = new File(['ok'], 'ok.txt', { type: 'text/plain' });
      const input = screen.getByTestId('file-tree-upload-input') as HTMLInputElement;

      await userEvent.click(screen.getByTitle('Upload files'));
      await userEvent.upload(input, [bigFile, okFile]);

      await waitFor(() => {
        if (toastMocks.error.mock.calls.length === 0) throw new Error('toast not fired yet');
      });
      await waitFor(() => {
        if (calls.length === 0) throw new Error('ok.txt not posted yet');
      });

      assert({
        given: 'a batch with one file over the 10 MiB client cap and one comfortably under it',
        should: 'toast the oversized file by name, skip POSTing it entirely, but still upload the other file and re-list once',
        actual: {
          toastMessage: toastMocks.error.mock.calls[0]?.[0],
          postedPaths: calls.map((c) => (c.body as Record<string, unknown>).path),
          rootRelistCount: listCallsFor('') - rootFetchesBefore,
        },
        expected: {
          toastMessage: 'big.bin: File is too large to upload',
          postedPaths: ['ok.txt'],
          rootRelistCount: 1,
        },
      });
    });

    test('Download fetches mode=download for the full path, then clicks an object-URL anchor named by the file\'s own basename', async () => {
      const downloadRequests: string[] = [];
      vi.mocked(fetchWithAuth).mockImplementation(async (...args: unknown[]) => {
        const url = String(args[0]);
        const init = (args[1] ?? {}) as RequestInit;
        const method = typeof init.method === 'string' ? init.method : 'GET';
        const parsed = new URL(url, 'http://test');
        if (method === 'GET' && parsed.searchParams.get('mode') === 'download') {
          downloadRequests.push(parsed.searchParams.get('path') ?? '');
          return new Response(new Blob(['contents']), { status: 200 });
        }
        const path = requestedPath(url);
        const entries = FAKE_FS[path];
        if (!entries) return jsonResponse({ error: 'not_found' }, 404);
        return jsonResponse({ entries });
      });

      // jsdom doesn't implement the Blob-URL/anchor-click machinery at all —
      // stub it in so the component's real download path (blob → object URL →
      // programmatic anchor click) is exercised and observable.
      if (typeof URL.createObjectURL !== 'function') {
        (URL as unknown as { createObjectURL: () => void }).createObjectURL = () => undefined;
      }
      if (typeof URL.revokeObjectURL !== 'function') {
        (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
      }
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

      try {
        renderTree();
        await expandFolder('src');
        await expandFolder('components');
        await waitFor(() => screen.getByText('Button.tsx'));

        fireEvent.contextMenu(screen.getByText('Button.tsx'));
        await userEvent.click(await waitFor(() => screen.getByText('Download')));

        await waitFor(() => {
          if (clickSpy.mock.calls.length === 0) throw new Error('anchor not clicked yet');
        });

        const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;

        assert({
          given: "Download chosen from 'Button.tsx'’s context menu, nested under src/components",
          should:
            "fetch mode=download for the full checkout-relative path, then click a same-tab object-URL anchor named by the file's own basename (not the full path)",
          actual: {
            downloadRequests,
            objectUrlCreated: createObjectURLSpy.mock.calls.length,
            objectUrlRevoked: revokeObjectURLSpy.mock.calls.length,
            anchorDownloadName: anchor.download,
          },
          expected: {
            downloadRequests: ['src/components/Button.tsx'],
            objectUrlCreated: 1,
            objectUrlRevoked: 1,
            anchorDownloadName: 'Button.tsx',
          },
        });
      } finally {
        createObjectURLSpy.mockRestore();
        revokeObjectURLSpy.mockRestore();
        clickSpy.mockRestore();
      }
    });

    test('a failed download toasts the route\'s own error', async () => {
      vi.mocked(fetchWithAuth).mockImplementation(async (...args: unknown[]) => {
        const url = String(args[0]);
        const parsed = new URL(url, 'http://test');
        if (parsed.searchParams.get('mode') === 'download') {
          return jsonResponse({ error: 'File is too large to download', reason: 'too_large' }, 413);
        }
        const path = requestedPath(url);
        const entries = FAKE_FS[path];
        if (!entries) return jsonResponse({ error: 'not_found' }, 404);
        return jsonResponse({ entries });
      });
      renderTree();

      await waitFor(() => screen.getByText('README.md'));
      fireEvent.contextMenu(screen.getByText('README.md'));
      await userEvent.click(await waitFor(() => screen.getByText('Download')));

      await waitFor(() => {
        if (toastMocks.error.mock.calls.length === 0) throw new Error('toast not fired yet');
      });

      assert({
        given: 'a download request that comes back 413 too_large',
        should: "toast the route's own error message",
        actual: toastMocks.error.mock.calls[0]?.[0],
        expected: 'File is too large to download',
      });
    });
  });
});
