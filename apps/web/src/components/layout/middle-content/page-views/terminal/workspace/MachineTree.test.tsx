import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/hooks/useGithubRepos', () => ({
  useGithubRepos: () => ({ repos: [], connected: true, isLoading: false, error: undefined, mutate: vi.fn() }),
}));

vi.mock('@/hooks/useIntegrations', () => ({
  useProviders: () => ({ providers: [] }),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import MachineTree, { type MachineTreeNode } from './MachineTree';

const TERMINAL_ID = 'machine-1';

const cannedFetch = () =>
  vi.mocked(fetchWithAuth).mockImplementation(async (...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes('/api/machines/projects')) {
      // TWO projects, each with an identically-named branch: nearly every repo has
      // a 'main', so a node-identity check that ignored projectName would highlight
      // the 'main' row under EVERY project while only one is being diffed.
      return new Response(
        JSON.stringify({
          projects: [
            { name: 'my-repo', repoUrl: 'https://github.com/org/my-repo.git', path: '/repo', createdAt: '2026-01-01' },
            { name: 'other-repo', repoUrl: 'https://github.com/org/other-repo.git', path: '/other', createdAt: '2026-01-01' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/machines/branches')) {
      // my-repo carries TWO branches so node identity is pinned on BOTH axes: the
      // two projects (above) cover the projectName half, these cover branchName.
      // Without a second branch here, an identity check that ignored branchName
      // would highlight every branch under the selected project at once.
      const branches = url.includes('projectName=my-repo')
        ? [
            { branchName: 'main', createdAt: '2026-01-01' },
            { branchName: 'feat/x', createdAt: '2026-01-01' },
          ]
        : [{ branchName: 'main', createdAt: '2026-01-01' }];
      return new Response(JSON.stringify({ branches }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });

const renderTree = (props: Partial<Parameters<typeof MachineTree>[0]> = {}) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MachineTree machineId={TERMINAL_ID} {...props} />
    </SWRConfig>,
  );

/** The row's chevron and its label live in separate buttons (see TreeRow) — find the row by its label text, then click just the chevron within it. */
const expandRowFor = async (labelText: string) => {
  const label = await waitFor(() => screen.getByText(labelText));
  const row = label.closest('.group') as HTMLElement;
  await userEvent.click(within(row).getByTestId('expand-chevron'));
};

describe('MachineTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cannedFetch();
  });

  test('renders the same Machine -> Project -> Branch data the hooks report', async () => {
    renderTree();

    await expandRowFor('my-repo');
    const branchRow = await waitFor(() => screen.getByText('main'));

    assert({
      given: 'a machine with one project and that project expanded via its chevron',
      should: 'show the branch reported by useMachineBranches',
      actual: branchRow.textContent,
      expected: 'main',
    });
  });

  test('clicking a project row calls onSelectNode with that project node, not a hardcoded action', async () => {
    const onSelectNode = vi.fn();
    renderTree({ onSelectNode });

    const projectRow = await waitFor(() => screen.getByText('my-repo'));
    await userEvent.click(projectRow);

    const expected: MachineTreeNode = { level: 'project', projectName: 'my-repo' };
    assert({
      given: 'onSelectNode passed as a prop and a project row clicked',
      should: 'invoke onSelectNode with the project node — no useTerminalWorkspaceStore coupling',
      actual: onSelectNode.mock.calls[0]?.[0],
      expected,
    });
  });

  test('selecting a project does not also toggle its expansion', async () => {
    const onSelectNode = vi.fn();
    renderTree({ onSelectNode });

    const projectRow = await waitFor(() => screen.getByText('my-repo'));
    await userEvent.click(projectRow);

    // Selecting must not be coupled to expand/collapse — a caller re-selecting an
    // already-expanded row (or just selecting a collapsed one) shouldn't flip its
    // disclosure state as a side effect.
    assert({
      given: 'a project row clicked to select it (not its chevron)',
      should: 'leave the row collapsed — its branches stay hidden',
      actual: screen.queryByText('main'),
      expected: null,
    });
  });

  test('a node excluded by isNodeSelectable keeps expand-on-label-click instead of becoming a dead button', async () => {
    // The Diff tab selects BRANCHES only. Without this opt-in, passing
    // onSelectNode would attach a select handler to every row — and since a
    // select handler is used INSTEAD of expand-on-label-click, the Machine and
    // Project labels would swallow the click and do nothing at all.
    const onSelectNode = vi.fn();
    renderTree({ onSelectNode, isNodeSelectable: (node: MachineTreeNode) => node.level === 'branch' });

    const projectRow = await waitFor(() => screen.getByText('my-repo'));
    await userEvent.click(projectRow);

    const branchRow = await waitFor(() => screen.getByText('main'));
    assert({
      given: 'onSelectNode with only branch nodes marked selectable, and a project label clicked',
      should: 'expand the project (not select it) — the label must stay live',
      actual: { expanded: branchRow.textContent, selected: onSelectNode.mock.calls.length },
      expected: { expanded: 'main', selected: 0 },
    });
  });

  /** The row's LABEL button — the interactive element, which is where aria-current has to live. */
  const labelButtonIn = (row: HTMLElement) => within(row).getAllByRole('button')[row.querySelector('[data-testid="expand-chevron"]') ? 1 : 0];

  test('the selected branch is marked aria-current — under ITS project only', async () => {
    // Both projects have a 'main'. Only my-repo/main is selected, so a
    // node-identity check that ignored projectName would light up both.
    renderTree({
      onSelectNode: vi.fn(),
      isNodeSelectable: (node: MachineTreeNode) => node.level === 'branch',
      selectedNode: { level: 'branch', projectName: 'my-repo', branchName: 'main' },
    });

    await expandRowFor('my-repo');
    await expandRowFor('other-repo');
    const mainRows = await waitFor(() => {
      const rows = screen.getAllByText('main');
      if (rows.length < 2) throw new Error('waiting for both projects to list their branches');
      return rows;
    });

    // aria-current must be on the interactive label button: the row wrapper has no
    // role and isn't focusable, so AT never reaches it.
    const current = mainRows.map((label) => {
      const row = label.closest('.group') as HTMLElement;
      return labelButtonIn(row).getAttribute('aria-current');
    });

    assert({
      given: "two projects that each have a 'main' branch, with only my-repo/main selected",
      should: 'mark exactly ONE of them current — the one under the selected project',
      actual: { currentCount: current.filter((c) => c === 'true').length, total: current.length },
      expected: { currentCount: 1, total: 2 },
    });
  });

  test('a SIBLING branch in the same project is not marked current', async () => {
    // The other half of node identity: my-repo has both 'main' and 'feat/x'.
    // Selecting one must not light up the other, or the sidebar claims two
    // branches are being diffed while the pane shows one.
    renderTree({
      onSelectNode: vi.fn(),
      isNodeSelectable: (node: MachineTreeNode) => node.level === 'branch',
      selectedNode: { level: 'branch', projectName: 'my-repo', branchName: 'feat/x' },
    });

    await expandRowFor('my-repo');
    const selectedRow = (await waitFor(() => screen.getByText('feat/x'))).closest('.group') as HTMLElement;
    const siblingRow = screen.getAllByText('main')[0].closest('.group') as HTMLElement;

    assert({
      given: "one project holding two branches, with only feat/x selected",
      should: 'mark feat/x current and leave its sibling main uncurrent',
      actual: {
        selected: labelButtonIn(selectedRow).getAttribute('aria-current'),
        sibling: labelButtonIn(siblingRow).getAttribute('aria-current'),
      },
      expected: { selected: 'true', sibling: null },
    });
  });

  test('no selectedNode leaves every row uncurrent (the Terminal tab has no persistent selection)', async () => {
    renderTree();

    const projectRow = (await waitFor(() => screen.getByText('my-repo'))).closest('.group') as HTMLElement;
    assert({
      given: 'a tree rendered without selectedNode',
      should: 'mark nothing current',
      actual: labelButtonIn(projectRow).getAttribute('aria-current'),
      expected: null,
    });
  });

  test('a node included by isNodeSelectable still selects (and does not expand)', async () => {
    const onSelectNode = vi.fn();
    renderTree({ onSelectNode, isNodeSelectable: (node: MachineTreeNode) => node.level === 'branch' });

    await expandRowFor('my-repo');
    const branchRow = await waitFor(() => screen.getByText('main'));
    await userEvent.click(branchRow);

    assert({
      given: 'a selectable branch row clicked',
      should: 'report the branch node to onSelectNode',
      actual: onSelectNode.mock.calls[0]?.[0],
      expected: { level: 'branch', projectName: 'my-repo', branchName: 'main' },
    });
  });

  test('with no onSelectNode, clicking a node label toggles its expansion (row-click affordance)', async () => {
    // The Terminal tab renders MachineTree without onSelectNode; the label must
    // still expand the row on click (like the old Navigator), not be a dead button.
    renderTree();

    const projectRow = await waitFor(() => screen.getByText('my-repo'));
    await userEvent.click(projectRow);

    const branchRow = await waitFor(() => screen.getByText('main'));
    assert({
      given: 'no onSelectNode and a project label (not its chevron) clicked',
      should: 'expand the row — its branch becomes visible',
      actual: branchRow.textContent,
      expected: 'main',
    });
  });

  test('renderNodeChildren injects caller content under an expanded node', async () => {
    renderTree({
      renderNodeChildren: (node: MachineTreeNode) =>
        node.level === 'machine' ? <div data-testid="injected-slot">injected</div> : null,
    });

    const injected = await waitFor(() => screen.getByTestId('injected-slot'));
    assert({
      given: 'a renderNodeChildren slot targeting the machine node',
      should: 'render the caller-provided content under the expanded machine node',
      actual: injected.textContent,
      expected: 'injected',
    });
  });

  test('a branch row has no expand chevron when renderNodeChildren is not provided', async () => {
    renderTree();

    await expandRowFor('my-repo');
    const branchLabel = await waitFor(() => screen.getAllByText('main')[0]);
    const branchRow = branchLabel.closest('.group') as HTMLElement;

    // Asserted on the BRANCH ROW itself rather than by counting chevrons across the
    // whole tree — a global count silently depends on how many projects the fixture
    // happens to have.
    assert({
      given: 'no renderNodeChildren slot passed',
      should: 'not offer an expand/collapse control on the branch row (it renders as a flat, selectable leaf)',
      actual: within(branchRow).queryByTestId('expand-chevron'),
      expected: null,
    });
  });
});
