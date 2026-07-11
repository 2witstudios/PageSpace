import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import type { MachineTreeNode } from '../workspace/MachineTree';
import type { MachineDiffFilesResponse } from '@/hooks/useMachineDiff';
import type { MachineDiffScope } from '@pagespace/lib/services/sandbox/machine-diff-scope';

// The tree is exercised by its own suite; here we only need a way to fire
// onSelectNode with a branch node, so stub it to a pair of select buttons.
vi.mock('../workspace/MachineTree', () => ({
  default: ({ onSelectNode }: { onSelectNode?: (node: MachineTreeNode) => void }) => (
    <div>
      <button type="button" onClick={() => onSelectNode?.({ level: 'branch', projectName: 'repo', branchName: 'feature' })}>
        select-feature
      </button>
      <button type="button" onClick={() => onSelectNode?.({ level: 'branch', projectName: 'repo', branchName: 'main' })}>
        select-main
      </button>
      <button type="button" onClick={() => onSelectNode?.({ level: 'project', projectName: 'repo' })}>
        select-project
      </button>
    </div>
  ),
}));

// Monaco must never mount under jsdom; the card only needs to prove it renders.
vi.mock('@/components/editors/MonacoDiffEditor', () => ({
  default: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="monaco-diff">{`${original}→${modified}`}</div>
  ),
}));

// The scope toggle's behaviour is driven entirely by what the files hook
// returns for each (branch, scope) — so the mock keys off branchName + scope:
// 'main' answers notApplicable for the non-uncommitted scopes (mirroring the
// route), every other branch answers a real list.
const filesFor = (branchName: string, scope: string): MachineDiffFilesResponse => {
  if (branchName === 'main' && scope !== 'uncommitted') {
    return { notApplicable: true };
  }
  if (branchName === 'main') {
    // Clean uncommitted tree on main — drives the explicit empty state.
    return { notApplicable: false, scope: 'uncommitted', files: [], truncated: false };
  }
  return {
    notApplicable: false,
    scope: scope as MachineDiffScope,
    files: [{ path: `src/${scope}.ts`, status: 'modified' }],
    truncated: false,
  };
};

vi.mock('@/hooks/useMachineDiff', () => ({
  useMachineDiffFiles: (
    _machineId: string,
    projectName: string | null,
    branchName: string | null,
    scope: string | null,
  ) => ({
    data: projectName && branchName && scope ? filesFor(branchName, scope) : undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useMachineDiffPair: () => ({
    data: { notApplicable: false, scope: 'uncommitted', path: 'x', original: 'a', modified: 'b' },
    error: undefined,
    isLoading: false,
  }),
}));

import DiffTab from './DiffTab';

describe('DiffTab', () => {
  beforeEach(() => vi.clearAllMocks());

  test('shows the empty placeholder until a branch is selected', () => {
    render(<DiffTab machineId="m1" />);
    assert({
      given: 'the Diff tab before any branch is picked',
      should: 'prompt to select a branch and render no scope toggle',
      actual: {
        prompt: screen.queryByText('Select a branch to view its diff.') !== null,
        toggle: screen.queryByText('Committed') !== null,
      },
      expected: { prompt: true, toggle: false },
    });
  });

  test('a non-main branch shows all three scope options', async () => {
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));

    await waitFor(() => screen.getByText('Committed'));
    assert({
      given: 'a feature branch where committed/branch scopes are applicable',
      should: 'render Uncommitted, Committed and Branch vs master in the toggle',
      actual: {
        uncommitted: screen.queryByText('Uncommitted') !== null,
        committed: screen.queryByText('Committed') !== null,
        branch: screen.queryByText('Branch vs master') !== null,
      },
      expected: { uncommitted: true, committed: true, branch: true },
    });
  });

  test('the main branch collapses the toggle to Uncommitted alone (no disabled options)', async () => {
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-main'));

    await waitFor(() => screen.getByText('Uncommitted'));
    assert({
      given: 'the main branch, where the route returns notApplicable for committed/branch',
      should: 'render ONLY the Uncommitted option — not all three with two disabled',
      actual: {
        uncommitted: screen.queryByText('Uncommitted') !== null,
        committed: screen.queryByText('Committed') !== null,
        branch: screen.queryByText('Branch vs master') !== null,
      },
      expected: { uncommitted: true, committed: false, branch: false },
    });
  });

  test('a clean uncommitted tree on main shows the explicit empty state', async () => {
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-main'));

    await waitFor(() => screen.getByText('Uncommitted'));
    assert({
      given: 'main selected with no uncommitted changes',
      should: 'name the branch in an explicit empty state, not a generic no-diff message',
      actual: screen.queryByText('No uncommitted changes on main') !== null,
      expected: true,
    });
  });

  test('a changed file expands into a Monaco diff editor on click', async () => {
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));

    const fileRow = await waitFor(() => screen.getByText('src/uncommitted.ts'));
    assert({
      given: 'a feature branch with one changed file',
      should: 'render the file collapsed (no editor) before it is clicked',
      actual: screen.queryByTestId('monaco-diff') !== null,
      expected: false,
    });

    await userEvent.click(fileRow);
    await waitFor(() => screen.getByTestId('monaco-diff'));
    assert({
      given: 'the changed file card clicked open',
      should: 'mount MonacoDiffEditor with the fetched original/modified pair',
      actual: screen.getByTestId('monaco-diff').textContent,
      expected: 'a→b',
    });
  });
});
