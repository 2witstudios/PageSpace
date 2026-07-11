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
//
// The stub CAPTURES the props it receives. Dropping `isNodeSelectable` or
// `selectedNode` from DiffTab's <MachineTree> would otherwise leave the suite
// green while, in the real app, every Machine/Project label became a dead button
// (a select handler wins over expand-on-label-click) and the selected branch lost
// its highlight.
const treeProps: {
  isNodeSelectable?: (node: MachineTreeNode) => boolean;
  selectedNode?: MachineTreeNode | null;
} = {};

vi.mock('../workspace/MachineTree', () => ({
  default: ({
    onSelectNode,
    isNodeSelectable,
    selectedNode,
  }: {
    onSelectNode?: (node: MachineTreeNode) => void;
    isNodeSelectable?: (node: MachineTreeNode) => boolean;
    selectedNode?: MachineTreeNode | null;
  }) => {
    treeProps.isNodeSelectable = isNodeSelectable;
    treeProps.selectedNode = selectedNode;
    return (
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
    );
  },
}));

// Monaco must never mount under jsdom; the card only needs to prove it renders.
vi.mock('@/components/editors/MonacoDiffEditor', () => ({
  default: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="monaco-diff">{`${original}→${modified}`}</div>
  ),
}));

// Per-test switches for the states the pane must not get wrong.
let truncatedSide: 'original' | 'modified' | null = null;
let binaryPair = false;
let truncatedEmptyList = false;
let probeErrors = false;
let listErrors = false;
let pairErrors = false;
let samePathAcrossScopes = false;

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
    // Normally each scope names its file after itself so tests can tell them
    // apart. When a path exists in BOTH scopes (the realistic case — committed and
    // branch are both merge-base-derived and overlap heavily), a card's React key
    // no longer changes across a scope switch, which is what makes the per-scope
    // TabsContent keying observable.
    files: [{ path: samePathAcrossScopes ? 'src/shared.ts' : `src/${scope}.ts`, status: 'modified' }],
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
const pairFor = (enabled: boolean) => {
  if (!enabled) return { data: undefined, error: undefined, isLoading: false };
  if (pairErrors) return { data: undefined, error: new Error('blob read failed'), isLoading: false };
  return {
    data: {
      notApplicable: false as const,
      scope: 'uncommitted' as const,
      path: 'src/uncommitted.ts',
      // BOTH sides must be able to be the truncated one: a blob side is cut at
      // 256 KB while a working-tree side gets 2 MB, so the ORIGINAL (a blob in
      // every scope) is the likelier casualty — a sniff that only checked
      // `modified` would miss it and paint the file's untouched tail as added.
      original: binaryPair
        ? { content: `PNG${NUL}${NUL}`, truncated: false }
        : { content: 'a', truncated: truncatedSide === 'original' },
      modified: binaryPair ? null : { content: 'b', truncated: truncatedSide === 'modified' },
    },
    error: undefined,
    isLoading: false,
  };
};

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
    // Keep the REAL key builders and filter — the refresh path's correctness
    // depends on them agreeing, and stubs would let a mismatch slip through.
    machineDiffKeyFilter: actual.machineDiffKeyFilter,
    machineDiffListKey: actual.machineDiffListKey,
    machineDiffPairKey: actual.machineDiffPairKey,
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
      // The ACTIVE list failing (as opposed to the probe) must surface, not spin.
      if (listErrors && scope === 'uncommitted') {
        return {
          data: undefined,
          error: new Error('sandbox unreachable'),
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
import { machineDiffListKey, machineDiffPairKey } from '@/hooks/useMachineDiff';

const scopeOptions = () => ({
  uncommitted: screen.queryByText('Uncommitted') !== null,
  committed: screen.queryByText('Committed') !== null,
  branch: screen.queryByText('Branch vs default') !== null,
});

describe('DiffTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    truncatedSide = null;
    binaryPair = false;
    truncatedEmptyList = false;
    probeErrors = false;
    listErrors = false;
    pairErrors = false;
    samePathAcrossScopes = false;
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

  test('the tree is told that ONLY branch rows are selectable', () => {
    render(<DiffTab machineId="m1" />);

    // Load-bearing: a row WITH a select handler uses it instead of
    // expand-on-label-click, and DiffTab's handler ignores non-branch nodes — so
    // marking Machine/Project selectable turns their labels into dead buttons.
    assert({
      given: 'the Diff tab rendering the shared tree',
      should: 'pass isNodeSelectable so Machine/Project rows keep expand-on-label-click',
      actual: {
        wired: typeof treeProps.isNodeSelectable === 'function',
        branch: treeProps.isNodeSelectable?.({ level: 'branch', projectName: 'repo', branchName: 'x' }),
        project: treeProps.isNodeSelectable?.({ level: 'project', projectName: 'repo' }),
        machine: treeProps.isNodeSelectable?.({ level: 'machine' }),
      },
      expected: { wired: true, branch: true, project: false, machine: false },
    });
  });

  test('the tree is told which branch is selected, so the sidebar can show it', async () => {
    render(<DiffTab machineId="m1" />);
    assert({
      given: 'no branch picked yet',
      should: 'report no selection',
      actual: treeProps.selectedNode ?? null,
      expected: null,
    });

    await userEvent.click(screen.getByText('select-feature'));
    await waitFor(() => screen.getByText('Uncommitted'));

    assert({
      given: 'a branch selected',
      should: 'thread that branch back to the tree as selectedNode — otherwise nothing shows which branch is being diffed',
      actual: treeProps.selectedNode,
      expected: { level: 'branch', projectName: 'repo', branchName: 'feature' },
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

  test('clicking a scope switches the list to that scope', async () => {
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));
    await waitFor(() => screen.getByText('src/uncommitted.ts'));

    await userEvent.click(screen.getByText('Committed'));

    // `value` is fully controlled by `active`, so without this the toggle could
    // render all three options while `setScope` did nothing and every other test
    // still passed — the options are asserted everywhere, the SWITCH nowhere.
    // The files mock names each file after its scope, so the list proves it.
    await waitFor(() => screen.getByText('src/committed.ts'));
    assert({
      given: 'the Committed scope trigger clicked',
      should: "re-fetch and render THAT scope's changed files, not the previous scope's",
      actual: {
        committed: screen.queryByText('src/committed.ts') !== null,
        uncommittedGone: screen.queryByText('src/uncommitted.ts') === null,
      },
      expected: { committed: true, uncommittedGone: true },
    });
  });

  test("every scope trigger's aria-controls resolves to a real tabpanel", async () => {
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));
    await waitFor(() => screen.getByText('Committed'));

    // Radix hands TabsContent's children to Presence AS A FUNCTION, which
    // force-mounts — so an INACTIVE panel's <div> is still in the DOM (only its
    // children are gated). Rendering one panel instead of one-per-scope therefore
    // leaves the two inactive triggers pointing at ids that exist nowhere: a
    // dangling IDREF, which is exactly what the Tabs wrapper exists to prevent.
    const dangling = screen
      .getAllByRole('tab')
      .map((tab) => tab.getAttribute('aria-controls'))
      .filter((id) => id === null || document.getElementById(id) === null);

    assert({
      given: 'the three scope triggers',
      should: 'each control a tabpanel that actually exists in the DOM',
      actual: { tabs: screen.getAllByRole('tab').length, dangling: dangling.length },
      expected: { tabs: 3, dangling: 0 },
    });
  });

  test('switching scope collapses an open card even when the same file exists in both scopes', async () => {
    // The per-scope TabsContent `key` gives each scope its own subtree, so a scope
    // switch UNMOUNTS the old panel. Without it, a card whose path appears in both
    // lists keeps its React key, stays expanded, and immediately refetches its pair
    // under the new scope — an extra sandbox git exec per open card, every switch.
    samePathAcrossScopes = true;
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));
    await userEvent.click(await waitFor(() => screen.getByText('src/shared.ts')));
    await waitFor(() => screen.getByTestId('monaco-diff'));

    await userEvent.click(screen.getByText('Committed'));
    await waitFor(() => screen.getByText('src/shared.ts'));

    assert({
      given: 'an expanded card for a file present in both the uncommitted and committed scopes',
      should: 'collapse it on the scope switch — not carry it open into the new scope and refetch',
      actual: screen.queryByTestId('monaco-diff') !== null,
      expected: false,
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

  test('a recovered probe drags the active scope back to Uncommitted', async () => {
    // The one reachable path to a scope that is selected but not applicable:
    // the probe fails transiently (so the full toggle shows), the user picks
    // Committed, then the probe recovers and answers notApplicable — this IS the
    // default branch. `active` must fall back to 'uncommitted' rather than leave a
    // meaningless scope selected and render the not-applicable notice.
    probeErrors = true;
    const { rerender } = render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-main'));

    await waitFor(() => screen.getByText('Committed'));
    await userEvent.click(screen.getByText('Committed'));

    probeErrors = false;
    rerender(<DiffTab machineId="m1" />);

    await waitFor(() => screen.getByText(/No uncommitted changes on main/i));
    assert({
      given: "a Committed scope selected while the probe was failing, then the probe recovering with notApplicable",
      should: 'fall back to Uncommitted — not strand the user on a scope this branch does not have',
      actual: {
        fellBack: screen.queryByText(/No uncommitted changes on main/i) !== null,
        strandedNotice: screen.queryByText(/doesn't apply on/i) !== null,
        committedStillOffered: screen.queryByText('Committed') !== null,
      },
      expected: { fellBack: true, strandedNotice: false, committedStillOffered: false },
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
    //
    // And it must be SCOPED to this branch: Machine pages stay mounted in a
    // keep-alive LRU, so a machine-agnostic predicate would re-fire another
    // machine's git execs (list + merge-base + every open pair) on every refresh.
    const predicate = swrMutate.mock.calls[0]?.[0] as ((key: unknown) => boolean) | undefined;
    // Real keys from the real builders, so a param reorder can't leave this green
    // while Refresh silently matches nothing in the app.
    const f = { path: 'src/a.ts', status: 'modified' as const };

    assert({
      given: 'the Refresh button clicked',
      should: "revalidate THIS branch's list and per-file pair keys — and nothing else's",
      actual: {
        called: swrMutate.mock.calls.length,
        myList: predicate?.(machineDiffListKey('m1', 'repo', 'feature', 'uncommitted')),
        myPair: predicate?.(machineDiffPairKey('m1', 'repo', 'feature', 'uncommitted', f)),
        otherMachine: predicate?.(machineDiffListKey('m2', 'repo', 'feature', 'uncommitted')),
        otherBranch: predicate?.(machineDiffListKey('m1', 'repo', 'other', 'uncommitted')),
        otherProject: predicate?.(machineDiffListKey('m1', 'other-repo', 'feature', 'uncommitted')),
        unrelatedRoute: predicate?.('/api/machines/files?machineId=m1'),
      },
      expected: {
        called: 1,
        myList: true,
        myPair: true,
        otherMachine: false,
        otherBranch: false,
        otherProject: false,
        unrelatedRoute: false,
      },
    });
  });

  test('a failed changed-file list surfaces the error instead of an endless spinner', async () => {
    listErrors = true;
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));

    await waitFor(() => screen.getByText(/Failed to load diff/i));
    assert({
      given: 'the changed-file list request failing',
      should: 'show the real error with a retry — falling through to a permanent "Loading…" would hide a dead machine',
      actual: {
        error: screen.queryByText(/Failed to load diff/i) !== null,
        detail: screen.queryByText(/sandbox unreachable/i) !== null,
        retry: screen.queryByRole('button', { name: 'Retry' }) !== null,
        stuckLoading: screen.queryByText('Loading changed files…') !== null,
      },
      expected: { error: true, detail: true, retry: true, stuckLoading: false },
    });
  });

  test("a failed file pair surfaces the error inside the card", async () => {
    pairErrors = true;
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));
    await userEvent.click(await waitFor(() => screen.getByText('src/uncommitted.ts')));

    await waitFor(() => screen.getByText(/Failed to load diff/i));
    assert({
      given: 'one file\'s diff pair failing to load',
      should: 'show the error in that card and mount no editor',
      actual: {
        error: screen.queryByText(/Failed to load diff: blob read failed/i) !== null,
        editor: screen.queryByTestId('monaco-diff') !== null,
      },
      expected: { error: true, editor: false },
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

  test('a truncated ORIGINAL side is called out — the likelier cut, and the one that fakes added lines', async () => {
    // The original is a git BLOB in every scope, capped at 256 KB, while a
    // working-tree side gets 2 MB. So a 300 KB file's original is cut while its
    // modified side is whole — and diffing them paints the file's entire untouched
    // tail as ADDED lines. A sniff that only checked `modified` would miss exactly
    // this, the most likely truncation in production.
    truncatedSide = 'original';
    render(<DiffTab machineId="m1" />);
    await userEvent.click(screen.getByText('select-feature'));
    await userEvent.click(await waitFor(() => screen.getByText('src/uncommitted.ts')));

    await waitFor(() => screen.getByTestId('monaco-diff'));
    assert({
      given: 'a file whose ORIGINAL side the sandbox cut at the 256 KB blob cap',
      should: 'warn that the diff is cut off, rather than presenting the untouched tail as new lines',
      actual: screen.queryByText(/too large to load in full/i) !== null,
      expected: true,
    });
  });

  test('a truncated MODIFIED side is called out instead of being rendered as the whole file', async () => {
    truncatedSide = 'modified';
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
