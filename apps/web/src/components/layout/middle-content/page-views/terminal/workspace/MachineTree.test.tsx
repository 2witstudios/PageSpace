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
      return new Response(
        JSON.stringify({ projects: [{ name: 'my-repo', repoUrl: 'https://github.com/org/my-repo.git', path: '/repo', createdAt: '2026-01-01' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/machines/branches')) {
      return new Response(
        JSON.stringify({ branches: [{ branchName: 'main', createdAt: '2026-01-01' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
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

  test('the selected node is highlighted and marked aria-current', async () => {
    renderTree({
      onSelectNode: vi.fn(),
      selectedNode: { level: 'branch', projectName: 'my-repo', branchName: 'main' },
    });

    await expandRowFor('my-repo');
    const branchRow = (await waitFor(() => screen.getByText('main'))).closest('.group') as HTMLElement;
    const projectRow = screen.getByText('my-repo').closest('.group') as HTMLElement;

    // Without this the Diff tab gives no sign of which branch it is diffing.
    assert({
      given: 'a selectedNode naming one branch',
      should: 'mark THAT row current (and not its siblings/ancestors)',
      actual: {
        branch: branchRow.getAttribute('aria-current'),
        project: projectRow.getAttribute('aria-current'),
      },
      expected: { branch: 'true', project: null },
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
    await waitFor(() => screen.getByText('main'));

    // Machine and Project rows each have a chevron; a bare branch row (no renderNodeChildren) should not add a third.
    assert({
      given: 'no renderNodeChildren slot passed',
      should: 'not offer an expand/collapse control on branch rows (they render as flat, selectable leaves)',
      actual: screen.getAllByTestId('expand-chevron').length,
      expected: 2,
    });
  });
});
