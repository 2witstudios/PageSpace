import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';
import type { MachineTreeNode } from '../workspace/MachineTree';
import type { MachineDiffFilesResponse } from '@/hooks/useMachineDiff';
import type { MachineDiffScope } from '@pagespace/lib/services/sandbox/machine-diff-scope';

// A NUL byte is how a decoded binary file gives itself away (git's own
// heuristic). Kept as an escape, never a literal control char in the source.
const NUL = '\u0000';

// The tree is exercised by its own suite; here we only need a way to fire
// onSelectNode, so stub it to a set of select buttons — including a PROJECT node,
// which DiffTab must ignore.
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

// Per-test switches for the states the pane must not get wrong.
let truncatedPair = false;
let binaryPair = false;
let truncatedEmptyList = false;
let probeErrors = false;

// The scope toggle's behaviour is driven entirely by what the files hook returns
// for each (branch, scope) — so the mock keys off branchName + scope: 'main'
// answers notApplicable for the non-uncommitted scopes (mirroring the route),
// every other branch answers a real list.
const filesFor = (branchName: string, scope: string): MachineDiffFilesResponse => {
  if (branchName === 'main' && scope !== 'uncommitted') return { notApplicable: true };
  if (branchName === 'main') {
    // Clean uncommitted tree on main — drives the explicit empty state.
    return { notApplicable: false, scope: 'uncommitted', files: [], truncated: false };
  }
  if (truncatedEmptyList) {
    // The sandbox output cap cut the list before its FIRST complete entry: zero
    // files, but the diff is emphatically NOT clean.
    return { notApplicable: false, scope: scope as MachineDiffScope, files: [], truncated: true };
  }
  return {
    notApplicable: false,
    scope: scope as MachineDiffScope,
    files: [{ path: `src/${scope}.ts`, status: 'modified' }],
    truncated: false,
  };
};

// The pair fixture MUST mirror the route's real wire shape — each side is
// `{ content, truncated }` or null, NOT a bare string. An earlier version of this
// mock asserted the string shape and so kept the suite green while the production
// code handed Monaco an object; useMachineDiff.test.tsx now pins the real contract
// against fetchWithAuth so this mock can't drift from it again.
//
// The binary case deliberately nulls the MODIFIED side (a deleted binary): the
// card must sniff EITHER side, so an `&&` across the two would leak mojibake here.
const pairFor = (enabled: boolean) => ({
  data: enabled
    ? {
        notApplicable: false as const,
        scope: 'uncommitted' as const,
        path: 'src/uncommitted.ts',
        original: binaryPair
          ? { content: `PNG${NUL}${NUL}`, truncated: false }
          : { content: 'a', truncated: false },
        modified: binaryPair ? null : { content: 'b', truncated: truncatedPair },
      }
    : undefined,
  error: undefined,
  isLoading: false,
});

// Spy at the CALL SITE: proves DiffFileCard threads `expanded` into the hook's
// `enabled` gate. Asserting only "no editor while collapsed" would be satisfied by
// the JSX guard alone — leaving a mutation to `enabled: true` free to fire a
// content request per file on list render (the N-fetch regression the design
// forbids) with a green suite.
const useMachineDiffPairSpy = vi.fn(pairFor);

// SWR's global mutate — the refresh path calls it with a key predicate.
const swrMutate = vi.fn();
vi.mock('swr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('swr')>();
  return { ...actual, useSWRConfig: () => ({ mutate: swrMutate }) };
});

vi.mock('@/hooks/useMachineDiff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMachineDiff')>();
  return {
    // Keep the real key predicate — the refresh path depends on it.
    isMachineDiffKey: actual.isMachineDiffKey,
    useMachineDiffFiles: (
      _machineId: string,
      projectName: string | null,
      branchName: string | null,
      scope: string | null,
    ) => {
      // A failed PROBE (machine stopped, transient git failure) must never be
      // mistaken for the main branch's notApplicable answer.
      if (probeErrors && scope === 'committed') {
        return {
          data: undefined,
          error: new Error('Branch machine unreachable'),
          isLoading: false,
          isValidating: false,
          mutate: vi.fn(),
        };
      }
      return {
        data: projectName && branchName && scope ? filesFor(branchName, scope) : undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      };
    },
    useMachineDiffPair: (
      _machineId: string,
      _projectName: string | null,
      _branchName: string | null,
      _scope: string | null,
      _file: unknown,
      enabled: boolean,
    ) => useMachineDiffPairSpy(enabled),
  };
});

import DiffTab from './DiffTab';

const scopeOptions = () => ({
  uncommitted: screen.queryByText('Uncommitted') !== null,
  committed: screen.queryByText('Committed') !== null,
  branch: screen.queryByText('Branch vs default') !== null,
});

describe('DiffTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    truncatedPair = false;
    binaryPair = false;
    truncatedEmptyList = false;
    probeErrors = false;
  });

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

  test('selecting a PROJECT node does not open a diff — only a branch identifies a checkout', async () => {
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-project'));

    assert({
      given: 'a project node reported by the tree',
      should: 'ignore it and keep prompting for a branch — a project has no single checkout to diff',
      actual: {
        prompt: screen.queryByText('Select a branch to view its diff.') !== null,
        toggle: screen.queryByText('Uncommitted') !== null,
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
      should: 'render all three scope options',
      actual: scopeOptions(),
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
      actual: scopeOptions(),
      expected: { uncommitted: true, committed: false, branch: false },
    });
  });

  test('an ERRORED probe keeps the full toggle — a failed request is not a main-branch answer', async () => {
    probeErrors = true;
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));

    await waitFor(() => screen.getByText('Uncommitted'));
    assert({
      given: 'the applicability probe failing (machine stopped / transient git failure)',
      should: 'keep all three scopes offered — collapsing here would silently hide real scopes on a flake',
      actual: scopeOptions(),
      expected: { uncommitted: true, committed: true, branch: true },
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

  test('an empty-but-TRUNCATED list is not reported as a clean tree', async () => {
    truncatedEmptyList = true;
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));

    await waitFor(() => screen.getByText('Uncommitted'));
    assert({
      given: 'a file list cut by the output cap before its first complete entry (files: [], truncated: true)',
      should: 'warn that the diff was cut — never claim "no changes" on partial data',
      actual: {
        warned: screen.queryByText(/too large to list in full/i) !== null,
        falselyClean: screen.queryByText(/^No uncommitted changes$/i) !== null,
      },
      expected: { warned: true, falselyClean: false },
    });
  });

  test('a collapsed card fetches nothing — the pair hook is called with enabled=false', async () => {
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));
    await waitFor(() => screen.getByText('src/uncommitted.ts'));

    assert({
      given: 'a changed-file list rendered with every card collapsed',
      should: 'gate the pair hook off, so a 200-file scope costs ZERO content requests until a card is opened',
      actual: {
        everCalled: useMachineDiffPairSpy.mock.calls.length > 0,
        everEnabled: useMachineDiffPairSpy.mock.calls.some(([enabled]) => enabled === true),
      },
      expected: { everCalled: true, everEnabled: false },
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
      should: "mount MonacoDiffEditor with each side's CONTENT string, not the raw { content, truncated } side object",
      actual: {
        rendered: screen.getByTestId('monaco-diff').textContent,
        enabledOnExpand: useMachineDiffPairSpy.mock.calls.some(([enabled]) => enabled === true),
      },
      expected: { rendered: 'a→b', enabledOnExpand: true },
    });
  });

  test("Refresh revalidates the expanded cards' pair keys, not just the file lists", async () => {
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));
    await waitFor(() => screen.getByText('src/uncommitted.ts'));

    await userEvent.click(screen.getByTitle('Refresh diff'));

    // The pane owns only the two LIST keys; every expanded card holds its own pair
    // key. Refreshing via the keyed predicate is what stops an open Monaco diff
    // from serving pre-edit content forever (both hooks are revalidateOnFocus:
    // false) — so assert the predicate actually reaches a pair key.
    const predicate = swrMutate.mock.calls[0]?.[0] as ((key: unknown) => boolean) | undefined;
    assert({
      given: 'the Refresh button clicked',
      should: "call SWR's global mutate with a predicate matching BOTH list and per-file pair keys",
      actual: {
        called: swrMutate.mock.calls.length,
        matchesList: predicate?.('/api/machines/diff?machineId=m1&scope=uncommitted'),
        matchesPair: predicate?.('/api/machines/diff?machineId=m1&scope=uncommitted&path=src%2Fa.ts'),
        matchesUnrelated: predicate?.('/api/machines/files?machineId=m1'),
      },
      expected: { called: 1, matchesList: true, matchesPair: true, matchesUnrelated: false },
    });
  });

  test('a binary file is named as such instead of rendering decoded mojibake', async () => {
    binaryPair = true;
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));
    await userEvent.click(await waitFor(() => screen.getByText('src/uncommitted.ts')));

    // Only the ORIGINAL side is binary here (a deleted binary has no modified
    // side), so a card that sniffed `original && modified` would fall through and
    // render garbage.
    assert({
      given: 'a changed binary file whose decoded content carries NUL bytes on one side only',
      should: 'say it is binary and mount no diff editor — a text diff of decoded bytes is garbage',
      actual: {
        note: screen.queryByText(/binary file/i) !== null,
        editor: screen.queryByTestId('monaco-diff') !== null,
      },
      expected: { note: true, editor: false },
    });
  });

  test('a truncated side is called out instead of being rendered as the whole file', async () => {
    truncatedPair = true;
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));
    await userEvent.click(await waitFor(() => screen.getByText('src/uncommitted.ts')));

    await waitFor(() => screen.getByTestId('monaco-diff'));
    assert({
      given: 'a file whose content the sandbox cut at its output cap',
      should: 'warn that the diff is cut off — silently diffing a truncated side paints the untouched tail as changed',
      actual: screen.queryByText(/too large to load in full/i) !== null,
      expected: true,
    });
  });
});
