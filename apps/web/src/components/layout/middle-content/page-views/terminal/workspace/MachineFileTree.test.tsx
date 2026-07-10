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
 * deliberately file-before-directory to prove the component sorts directories
 * first rather than echoing server order.
 */
const FAKE_FS: Record<string, { name: string; type: 'file' | 'directory' }[]> = {
  '': [
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

  test('sorts directories before files regardless of server order', async () => {
    renderTree();

    const file = await waitFor(() => screen.getByText('README.md'));
    const dir = screen.getByText('src');

    assert({
      given: 'a root listing the server returned file-first',
      should: 'render the directory row above the file row',
      actual: Boolean(dir.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING),
      expected: true,
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
