import { useEffect } from 'react';
import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

// Stub the branch picker: expose one button per node kind so a test can drive
// exactly the selection FilesTab reacts to, without pulling MachineTree's whole
// projects/branches hook subtree.
vi.mock('../workspace/MachineTree', () => ({
  default: ({ onSelectNode }: { onSelectNode?: (node: unknown) => void }) => (
    <div>
      <button type="button" onClick={() => onSelectNode?.({ level: 'machine' })}>pick-machine</button>
      <button
        type="button"
        onClick={() => onSelectNode?.({ level: 'branch', projectName: 'repo', branchName: 'main' })}
      >
        pick-main
      </button>
      <button
        type="button"
        onClick={() => onSelectNode?.({ level: 'branch', projectName: 'repo', branchName: 'dev' })}
      >
        pick-dev
      </button>
    </div>
  ),
}));

/**
 * Every root listing the (stubbed) file tree performs, in order.
 *
 * The stub MUST model the one behaviour of the real MachineFileTree that this
 * tab's correctness depends on: it self-keys on `${machineId}/${projectName}/
 * ${branchName}`, so mounting it — or handing it a new branch — fetches that
 * branch's root listing. A dumb stub that never fetches would let the "no wasted
 * listing" test pass even with FilesTab's key deleted, which is exactly the hole
 * a reviewer caught: the wasted listing came from the REAL tree, so a stub that
 * doesn't list cannot witness it.
 */
const treeListings: string[] = [];

vi.mock('../workspace/MachineFileTree', () => ({
  default: function MachineFileTreeStub({
    scope,
    onSelectFile,
  }: {
    scope: { kind: 'root' } | { kind: 'branch'; projectName: string; branchName: string };
    onSelectFile?: (path: string) => void;
  }) {
    const branchName = scope.kind === 'branch' ? scope.branchName : 'root';
    useEffect(() => {
      treeListings.push(branchName);
    }, [branchName]);
    return (
      <button type="button" data-testid="file-tree" onClick={() => onSelectFile?.('src/index.ts')}>
        tree:{branchName}
      </button>
    );
  },
}));

// Stub the main pane so FilesTab's composition (which file, which branch) is what's asserted.
vi.mock('./FilesFilePane', () => ({
  default: ({
    path,
    scope,
  }: {
    path: string;
    scope: { kind: 'root' } | { kind: 'branch'; projectName: string; branchName: string };
  }) => (
    <div data-testid="file-pane">
      pane:{scope.kind === 'branch' ? scope.branchName : 'root'}:{path}
    </div>
  ),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import FilesTab from './FilesTab';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Serve the checkout-root probe: `ready` for known branches, an absence reason otherwise. */
const cannedFetch = (perBranch: Record<string, () => Promise<Response>>) =>
  vi.mocked(fetchWithAuth).mockImplementation(async (...args: unknown[]) => {
    const branch = new URL(String(args[0]), 'http://test').searchParams.get('branchName') ?? '';
    const handler = perBranch[branch];
    if (handler) return handler();
    return jsonResponse({ error: 'unexpected branch' }, 500);
  });

describe('FilesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    treeListings.length = 0;
  });

  test('shows the branch prompt before any branch is picked', () => {
    cannedFetch({});
    render(<FilesTab machineId="machine-1" />);

    assert({
      given: 'a freshly mounted Files tab',
      should: 'prompt to select a branch and probe nothing',
      actual: {
        prompt: screen.queryByText('Select a branch to browse its checkout.') !== null,
        fetches: vi.mocked(fetchWithAuth).mock.calls.length,
      },
      expected: { prompt: true, fetches: 0 },
    });
  });

  test('selecting a machine (non-branch) node is ignored', async () => {
    cannedFetch({ main: async () => jsonResponse({ entries: [] }) });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-machine'));

    assert({
      given: 'a machine-level node selected (no checkout to browse)',
      should: 'keep the branch prompt and issue no probe',
      actual: {
        prompt: screen.queryByText('Select a branch to browse its checkout.') !== null,
        fetches: vi.mocked(fetchWithAuth).mock.calls.length,
      },
      expected: { prompt: true, fetches: 0 },
    });
  });

  test('picking a ready branch probes its checkout ONCE and mounts the file tree', async () => {
    cannedFetch({ main: async () => jsonResponse({ entries: [] }) });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-main'));
    const tree = await waitFor(() => screen.getByTestId('file-tree'));

    assert({
      given: 'a branch whose checkout probe returns 200',
      should: 'render the file tree for that branch, having probed exactly once',
      actual: {
        tree: tree.textContent,
        probes: vi.mocked(fetchWithAuth).mock.calls.length,
        filePrompt: screen.queryByText('Select a file to view its contents.') !== null,
      },
      expected: { tree: 'tree:main', probes: 1, filePrompt: true },
    });
  });

  test('switching branches never mounts the file tree against a stale ready state', async () => {
    cannedFetch({
      main: async () => jsonResponse({ entries: [] }),
      dev: async () => jsonResponse({ entries: [] }),
    });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-main'));
    await waitFor(() => screen.getByText('tree:main'));
    await userEvent.click(screen.getByText('pick-dev'));
    await waitFor(() => screen.getByText('tree:dev'));

    const branchesProbed = vi
      .mocked(fetchWithAuth)
      .mock.calls.map((call) => new URL(String(call[0]), 'http://test').searchParams.get('branchName'));

    assert({
      given: 'a branch switch after the first branch was already ready',
      should:
        'list each branch root exactly once — BranchFiles is keyed by branch, so the tree is never mounted at the new branch under the old ready state (unkeyed, dev is listed twice: once thrown away)',
      actual: { probed: branchesProbed, listed: treeListings },
      expected: { probed: ['main', 'dev'], listed: ['main', 'dev'] },
    });
  });

  test('re-picking the branch already open keeps the open file', async () => {
    cannedFetch({ main: async () => jsonResponse({ entries: [] }) });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-main'));
    await userEvent.click(await waitFor(() => screen.getByTestId('file-tree')));
    await waitFor(() => screen.getByTestId('file-pane'));

    await userEvent.click(screen.getByText('pick-main')); // same branch again

    assert({
      given: 'the branch that is already selected picked a second time',
      should: 'leave the open file alone (only a DIFFERENT branch invalidates the path)',
      actual: screen.queryByTestId('file-pane')?.textContent ?? null,
      expected: 'pane:main:src/index.ts',
    });
  });

  test('a not-yet-cloned branch shows the empty state, not the file tree', async () => {
    cannedFetch({ main: async () => jsonResponse({ error: 'Branch machine not_found', reason: 'not_found' }, 404) });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-main'));
    await waitFor(() => screen.getByTestId('checkout-absent'));

    assert({
      given: "a branch whose checkout probe returns reason 'not_found'",
      should: 'show the not-checked-out empty state and never mount the file tree',
      actual: {
        empty: screen.queryByText("This branch hasn't been checked out yet") !== null,
        tree: screen.queryByTestId('file-tree'),
      },
      expected: { empty: true, tree: null },
    });
  });

  test("a vanished sandbox reports the checkout is gone", async () => {
    cannedFetch({ main: async () => jsonResponse({ error: 'Branch machine vanished', reason: 'vanished' }, 503) });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-main'));
    const gone = await waitFor(() => screen.getByText('This branch checkout is gone'));

    assert({
      given: "a branch whose checkout probe returns reason 'vanished'",
      should: 'distinguish a reclaimed sandbox from a never-cloned branch',
      actual: gone.textContent,
      expected: 'This branch checkout is gone',
    });
  });

  test('a real failure (403) stays an error — it is NOT dressed up as an empty state', async () => {
    // The invariant behind the absent/error split: "no checkout" is a state of
    // the world; a permission failure is not, and must never be shown as one.
    cannedFetch({
      main: async () => jsonResponse({ error: 'You do not have access to this machine' }, 403),
    });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-main'));
    await waitFor(() => screen.getByTestId('checkout-error'));

    assert({
      given: 'a checkout probe rejected with 403 (no `reason` in the body)',
      should: "surface it as an error with the API's message, not as a not-checked-out empty state",
      actual: {
        error: screen.queryByText('You do not have access to this machine') !== null,
        absent: screen.queryByTestId('checkout-absent'),
        tree: screen.queryByTestId('file-tree'),
      },
      expected: { error: true, absent: null, tree: null },
    });
  });

  test('“Check again” re-probes a branch that has since been cloned', async () => {
    let cloned = false;
    cannedFetch({
      main: async () =>
        cloned
          ? jsonResponse({ entries: [] })
          : jsonResponse({ error: 'This branch checkout is unavailable', reason: 'not_found' }, 404),
    });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-main'));
    await waitFor(() => screen.getByTestId('checkout-absent'));

    cloned = true; // the user opened a terminal on the branch and cloned it
    await userEvent.click(screen.getByText('Check again'));
    await waitFor(() => screen.getByTestId('file-tree'));

    assert({
      given: 'a not-yet-cloned branch that gets cloned, then “Check again” clicked',
      should: 're-probe and mount the file tree without needing a branch re-pick',
      actual: {
        tree: screen.getByTestId('file-tree').textContent,
        absent: screen.queryByTestId('checkout-absent'),
      },
      expected: { tree: 'tree:main', absent: null },
    });
  });

  test('selecting a file in the tree opens it in the main pane', async () => {
    cannedFetch({ main: async () => jsonResponse({ entries: [] }) });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-main'));
    await userEvent.click(await waitFor(() => screen.getByTestId('file-tree')));
    const pane = await waitFor(() => screen.getByTestId('file-pane'));

    assert({
      given: 'a file clicked in a ready branch tree',
      should: 'render the file pane scoped to that branch and path',
      actual: pane.textContent,
      expected: 'pane:main:src/index.ts',
    });
  });

  test('switching branches drops the previously open file', async () => {
    cannedFetch({
      main: async () => jsonResponse({ entries: [] }),
      dev: async () => jsonResponse({ entries: [] }),
    });
    render(<FilesTab machineId="machine-1" />);

    await userEvent.click(screen.getByText('pick-main'));
    await userEvent.click(await waitFor(() => screen.getByTestId('file-tree')));
    await waitFor(() => screen.getByTestId('file-pane'));

    await userEvent.click(screen.getByText('pick-dev'));
    await waitFor(() => screen.getByText('tree:dev'));

    assert({
      given: 'a file open on one branch, then a different branch picked',
      should: 'clear the open file and fall back to the pick-a-file prompt',
      actual: {
        pane: screen.queryByTestId('file-pane'),
        filePrompt: screen.queryByText('Select a file to view its contents.') !== null,
      },
      expected: { pane: null, filePrompt: true },
    });
  });
});
