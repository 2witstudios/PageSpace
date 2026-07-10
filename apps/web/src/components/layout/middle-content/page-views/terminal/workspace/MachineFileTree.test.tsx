import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import MachineFileTree from './MachineFileTree';

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

const listCallsFor = (path: string): number =>
  vi.mocked(fetchWithAuth).mock.calls.filter((call) => requestedPath(String(call[0])) === path).length;

const renderTree = (props: Partial<Parameters<typeof MachineFileTree>[0]> = {}) =>
  render(
    <MachineFileTree terminalId="machine-1" projectName="my-repo" branchName="main" {...props} />,
  );

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
      <MachineFileTree terminalId="machine-1" projectName="my-repo" branchName="dev" />,
    );
    await waitFor(() => {
      if (listCallsFor('') < 2) throw new Error('new branch root listing not fetched yet');
    });

    assert({
      given: 'the branchName prop changed after a directory was expanded',
      should: 'refetch the root for the new branch and reset expansion (old children gone)',
      actual: { rootFetches: listCallsFor(''), staleChild: screen.queryByText('index.ts') },
      expected: { rootFetches: 2, staleChild: null },
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
      should: 'render a loading row under that directory',
      actual: screen.getByText('Loading…').textContent,
      expected: 'Loading…',
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
    const empty = await waitFor(() => screen.getByText('Empty'));

    assert({
      given: 'an expanded directory with no entries',
      should: 'render an "Empty" row instead of nothing',
      actual: empty.textContent,
      expected: 'Empty',
    });
  });
});
