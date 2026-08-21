/**
 * What the nested task tree actually puts in the DOM.
 *
 * Three of these cannot be reached by a pure-function test and are exactly the
 * things that were wrong before:
 *
 *  - Sub-tasks are SIBLING `<tr>`s in the same `<tbody>`, so their columns line
 *    up with their parent's. A wrapper element around them would be invalid
 *    HTML and would break the alignment that makes this read as a tree.
 *  - A nested checkbox PATCHes its PARENT TASK'S page, not the viewed list's.
 *    Addressing the root list 404s on the route's parent-child check.
 *  - A collapsed row issues NO request. `GET /api/pages/[pageId]/tasks` lazily
 *    writes a task_lists row plus status configs, so a row that fetches while
 *    collapsed is write amplification, not just a wasted request.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import type { TaskItem, TaskStatusConfig, LocatedTaskHandlers } from '../task-list-types';

const fetchWithAuth = vi.fn();
const patchMock = vi.fn();
const postMock = vi.fn();

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  patch: (...a: unknown[]) => patchMock(...a),
  post: (...a: unknown[]) => postMock(...a),
  del: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// The document half is a dynamically imported rich editor; rendering it would
// drag in the whole tiptap stack and is not what these cases are about.
vi.mock('next/dynamic', () => ({ default: () => function RichEditorStub() { return null; } }));
vi.mock('@/hooks/usePageContent', () => ({
  usePageContent: () => ({ content: '<p>doc</p>', isLoading: false }),
}));
// MultiAssigneeSelect fetches the drive's members; irrelevant here.
vi.mock('../MultiAssigneeSelect', () => ({ MultiAssigneeSelect: () => null }));

const { TaskRowGroup } = await import('../TaskRowGroup');
const { TaskTreeProvider } = await import('../task-tree-context');
const { rootNodePath, makeNodePath, expandNodePath } = await import('../task-tree-core');
const { useTaskWriteMachinery } = await import('@/lib/tasks/task-write-machinery');

const CONFIGS: TaskStatusConfig[] = [
  { id: 'c1', taskListId: 'l', name: 'To Do', slug: 'pending', color: 'x', group: 'todo', position: 0 },
  { id: 'c2', taskListId: 'l', name: 'Done', slug: 'completed', color: 'x', group: 'done', position: 1 },
];

const task = (over: Partial<TaskItem> & { id: string }): TaskItem => ({
  userId: 'u1',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: `page-${over.id}`,
  title: over.id,
  status: 'pending',
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const subTaskResponse = (tasks: TaskItem[], hasMore = false) => ({
  ok: true,
  json: async () => ({
    taskList: { id: 'sub', title: 'Sub', description: null, status: 'active', updatedAt: 'x' },
    tasks,
    statusConfigs: CONFIGS,
    hasMore,
  }),
});

const noopHandlers = (): LocatedTaskHandlers => ({
  onToggleComplete: vi.fn(),
  onStatusChange: vi.fn(),
  onPriorityChange: vi.fn(),
  onAssigneeChange: vi.fn(),
  onMultiAssigneeChange: vi.fn(),
  onDueDateChange: vi.fn(),
  onSaveTitle: vi.fn(),
  onDelete: vi.fn(),
  onNavigate: vi.fn(),
  onStartEdit: vi.fn(),
  onConfigureTriggers: vi.fn(),
});

const ROOT_PAGE = 'root-page';

/**
 * Stands in for TaskListView's depth-0 wrapper.
 *
 * Production never renders a top-level row through TaskRowGroup's own
 * `NestedTaskRow` — it always passes `renderRow`. A test that omits it is
 * asserting against a row shape the app does not ship, which is how an earlier
 * version "covered" aria-expanded while the real depth-0 row had none.
 */
const rootRenderRow = (
  children: React.ReactNode,
  tree: { expandable: boolean; isExpanded: boolean },
) => (
  <tr
    data-testid="root-row"
    aria-level={1}
    aria-expanded={tree.expandable ? tree.isExpanded : undefined}
  >
    <td />
    {children}
  </tr>
);

function Harness({
  tasks, expanded, canEdit = true, handlers = noopHandlers(), onCountDelta,
  renderRow, onStartEdit = vi.fn(), applyCountDeltas = false,
}: {
  tasks: TaskItem[];
  expanded: Set<string>;
  canEdit?: boolean;
  handlers?: LocatedTaskHandlers;
  onCountDelta?: (delta: { total?: number; completed?: number }) => void;
  renderRow?: (
    children: React.ReactNode,
    tree: { expandable: boolean; isExpanded: boolean },
  ) => React.ReactNode;
  onStartEdit?: (task: TaskItem) => void;
  /**
   * Apply count deltas to the rendered rows, the way the real cache does.
   * Off by default so the existing cases keep asserting the delta in isolation;
   * on for the ones that need the gate to actually open, since a sub-list only
   * fetches once its parent's count says there is something there.
   */
  applyCountDeltas?: boolean;
}) {
  const rootPath = rootNodePath(ROOT_PAGE);
  // Deliberately NOT wrapped in TaskWriteProvider: the app never renders one —
  // TaskListView owns the machinery and hands it down on the tree context. A
  // provider here would supply something production does not, and hid a crash
  // ("useTaskWriter requires a TaskWriteProvider") that only appeared in the
  // real app when a nested node mounted.
  const writeMachinery = useTaskWriteMachinery('user-me', vi.fn());
  const [liveExpanded, setLiveExpanded] = React.useState(expanded);
  const [counts, setCounts] = React.useState<Record<string, number>>({});
  const handleCountDelta = (delta: { total?: number; completed?: number }) => {
    onCountDelta?.(delta);
    if (!applyCountDeltas || !delta.total) return;
    setCounts((prev) => ({ ...prev, [tasks[0].id]: (prev[tasks[0].id] ?? tasks[0].subTaskCount ?? 0) + delta.total! }));
  };
  const tree = {
    canEdit,
    driveId: 'drive-1',
    writeMachinery,
    rootStatusConfigs: CONFIGS,
    onNavigate: vi.fn(),
    onStartEdit,
    openTriggerDialog: vi.fn(),
    expandedPaths: liveExpanded,
    toggleExpanded: vi.fn(),
    // Real, not a spy: the menu's "Add sub-task" expands the row it created
    // under, and a mocked expandNode leaves the subtree unmounted — which makes
    // every assertion about what happens once it renders vacuously true.
    expandNode: (path: string) => setLiveExpanded((prev) => expandNodePath(prev, path)),
    editingTaskId: null,
    editingTitle: '',
    onEditingTitleChange: vi.fn(),
    onCancelEdit: vi.fn(),
  };
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TaskTreeProvider value={tree}>
          <table>
            <tbody data-testid="rows">
              {tasks.map((t) => (
                <TaskRowGroup
                  key={t.id}
                  task={counts[t.id] === undefined ? t : { ...t, subTaskCount: counts[t.id] }}
                  depth={0}
                  listPageId={ROOT_PAGE}
                  path={makeNodePath(rootPath, t.id)}
                  handlers={handlers}
                  statusConfigs={CONFIGS}
                  onCountDelta={handleCountDelta}
                  renderRow={renderRow}
                />
              ))}
            </tbody>
          </table>
      </TaskTreeProvider>
    </SWRConfig>
  );
}

const expandedFor = (...taskIds: string[]) =>
  new Set(taskIds.map((id) => makeNodePath(rootNodePath(ROOT_PAGE), id)));

beforeEach(() => {
  fetchWithAuth.mockReset();
  patchMock.mockReset();
  postMock.mockReset();
});

describe('nested rows in the DOM', () => {
  it('emits only <tr> children into the tbody', async () => {
    // The <tbody> validity contract. Any wrapper element anyone adds around the
    // nested rows fails here rather than silently breaking column alignment (or
    // diverging between SSR and hydration).
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })]));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);
    await screen.findByText('child');

    const tbody = screen.getByTestId('rows');
    assert({
      given: 'an expanded parent with a child, an inline add row and affordances',
      should: 'have nothing but table rows directly inside the tbody',
      actual: [...tbody.children].map((el) => el.tagName),
      expected: [...tbody.children].map(() => 'TR'),
    });
  });

  it('places a child immediately after its parent and before the next sibling', async () => {
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })]));
    render(
      <Harness
        tasks={[task({ id: 'parent', subTaskCount: 1 }), task({ id: 'sibling' })]}
        expanded={expandedFor('parent')}
      />,
    );
    await screen.findByText('child');

    const titles = [...screen.getByTestId('rows').querySelectorAll('tr')]
      .map((tr) => tr.textContent ?? '')
      .filter((t) => /parent|child|sibling/.test(t));
    assert({
      given: 'an expanded parent followed by a sibling',
      should: 'order the child between them',
      actual: [
        titles.findIndex((t) => t.includes('parent')) < titles.findIndex((t) => t.includes('child')),
        titles.findIndex((t) => t.includes('child')) < titles.findIndex((t) => t.includes('sibling')),
      ],
      expected: [true, true],
    });
  });

  it('marks depth with aria-level so the tree is navigable', async () => {
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })]));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);
    await screen.findByText('child');

    const childRow = screen.getByText('child').closest('tr');
    assert({
      given: 'a first-level sub-task row',
      should: 'be announced as level 2',
      actual: childRow?.getAttribute('aria-level'),
      expected: '2',
    });
  });

  it('reports aria-expanded true, false, and absent for the three row states', async () => {
    // All three states, deliberately: an earlier version probed two LEAVES and
    // expected [false, false], which passes just as well with aria-expanded
    // removed from every row. The positive case is what gives the assertion
    // teeth, so the expanded parent and a collapsed-but-expandable child are
    // both in the same render.
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child', subTaskCount: 1 })]));
    render(
      <Harness
        tasks={[task({ id: 'parent', subTaskCount: 1 }), task({ id: 'leaf' })]}
        expanded={expandedFor('parent')}
        // Through the production wrapper: the depth-0 rows are the ones users
        // expand most, and they are exactly the ones an earlier version of this
        // test could not see.
        renderRow={rootRenderRow}
      />,
    );
    await screen.findByText('child');

    const ariaExpanded = (label: string) =>
      screen.getByText(label).closest('tr')?.getAttribute('aria-expanded');

    assert({
      given: 'a depth-0 expanded parent, its collapsed-but-expandable child, and a depth-0 leaf',
      should: 'say true, false, and nothing at all — at both depths',
      actual: {
        parent: ariaExpanded('parent'),
        child: ariaExpanded('child'),
        leaf: ariaExpanded('leaf'),
      },
      expected: { parent: 'true', child: 'false', leaf: null },
    });
  });

  it('places each sub-task in its set, and says nothing when the set is partial', async () => {
    // aria-level alone cannot say which sibling this is or how many there are —
    // the rows are flat <tr>s with no role="group" possible in a tbody. The
    // second half matters as much as the first: with more pages to load, any
    // setsize would be a claim about rows that are not there.
    fetchWithAuth
      .mockResolvedValueOnce(subTaskResponse([task({ id: 'one' }), task({ id: 'two' })]))
      .mockResolvedValue(subTaskResponse([task({ id: 'three' })], true));
    const { unmount } = render(
      <Harness tasks={[task({ id: 'parent', subTaskCount: 2 })]} expanded={expandedFor('parent')} />,
    );
    await screen.findByText('two');
    const set = (label: string) => {
      const row = screen.getByText(label).closest('tr');
      return [row?.getAttribute('aria-posinset'), row?.getAttribute('aria-setsize')];
    };
    const complete = { one: set('one'), two: set('two') };
    unmount();

    render(
      <Harness tasks={[task({ id: 'p2', subTaskCount: 5 })]} expanded={expandedFor('p2')} />,
    );
    await screen.findByText('three');
    const partial = set('three');

    assert({
      given: 'a fully loaded sub-list, and one with more pages to come',
      should: 'number the complete set and leave the partial one unsized',
      actual: { ...complete, partial },
      expected: { one: ['1', '2'], two: ['2', '2'], partial: ['1', null] },
    });
  });

  it('keeps the inline add row after the last sub-task is deleted', async () => {
    // The clear-out-and-re-add workflow. Rendering the subtree only while
    // subTaskCount > 0 meant the count hitting zero unmounted the add row
    // mid-flow, and the only way back was the row's ⋯ menu.
    fetchWithAuth.mockResolvedValue(subTaskResponse([]));
    render(
      <Harness tasks={[task({ id: 'parent', subTaskCount: 0, hasContent: true })]} expanded={expandedFor('parent')} />,
    );

    assert({
      given: 'an expanded row with a description and no sub-tasks',
      should: 'offer the add row, fetch nothing, and not claim sub-tasks went missing',
      actual: {
        addRow: !!screen.queryByPlaceholderText('+ Add a sub-task…'),
        fetches: fetchWithAuth.mock.calls.length,
        // A row is expandable for having a DESCRIPTION too. Saying "no longer
        // here" about sub-tasks that never existed is a statement about nothing.
        vanished: !!screen.queryByText('These sub-tasks are no longer here.'),
      },
      expected: { addRow: true, fetches: 0, vanished: false },
    });
  });
});

describe('the row menu\'s "Add sub-task" on a leaf', () => {
  const openMenuFor = async (title: string) => {
    const row = screen.getByText(title).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: new RegExp(`Actions for ${title}`, 'i') }));
  };

  it('creates the first sub-task, opens the row, and puts it into rename', async () => {
    // A leaf has no inline add row to type into, so the title has to be
    // something — but it must not stay "New sub-task" for the user to hunt down
    // and rename through a menu.
    postMock.mockResolvedValue(task({ id: 'first', title: 'New sub-task' }));
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'first', title: 'New sub-task' })]));
    const onCountDelta = vi.fn();
    const onStartEdit = vi.fn();
    render(
      <Harness
        tasks={[task({ id: 'leaf', subTaskCount: 0 })]}
        expanded={new Set()}
        onCountDelta={onCountDelta}
        onStartEdit={onStartEdit}
        applyCountDeltas
      />,
    );

    await openMenuFor('leaf');
    await userEvent.click(screen.getByRole('menuitem', { name: /Add sub-task/i }));

    await waitFor(() => expect(onStartEdit).toHaveBeenCalled(), { timeout: 3000 });
    assert({
      given: 'the menu item on a task with no sub-tasks',
      should: "POST under that task's own page, count it, and open the row into rename",
      actual: {
        url: postMock.mock.calls[0][0],
        delta: onCountDelta.mock.calls[0]?.[0],
        renaming: (onStartEdit.mock.calls[0]?.[0] as { id: string } | undefined)?.id,
      },
      expected: {
        url: '/api/pages/page-leaf/tasks',
        delta: { total: 1, completed: 0 },
        renaming: 'first',
      },
    });
  });

  it('does not open an editing session when the sub-list never loads', async () => {
    // onStartEdit opens an APP-WIDE session — it pauses the root list's
    // revalidation, disables Load More and defers auth refresh. Starting it when
    // the POST returns, before the row exists, latched it on nothing whenever
    // the sub-list fetch then failed: terminal here, so no row ever arrives and
    // there is nothing on screen to blur or Escape.
    postMock.mockResolvedValue(task({ id: 'first', title: 'New sub-task' }));
    fetchWithAuth.mockRejectedValue(new Error('offline'));
    const onStartEdit = vi.fn();
    render(
      <Harness
        tasks={[task({ id: 'leaf', subTaskCount: 0 })]}
        expanded={new Set()}
        onStartEdit={onStartEdit}
        applyCountDeltas
      />,
    );

    await openMenuFor('leaf');
    await userEvent.click(screen.getByRole('menuitem', { name: /Add sub-task/i }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 250));

    assert({
      given: 'a created sub-task whose list then failed to load',
      should: 'never start the edit, rather than latch it on a row that will not arrive',
      actual: onStartEdit.mock.calls.length,
      expected: 0,
    });
  });
});

describe('recovering a sub-list that failed to load', () => {
  // Carried over from TaskRowDescription's suite, which this component replaced;
  // both branches were left unasserted in the move.
  it('reloads a node whose count went 1 -> 0 -> 1 rather than serving the empty cache', async () => {
    // The clear-out-and-re-add workflow, which the un-gated subtree exists to
    // support. Deleting the last sub-task takes subTaskCount to 0, which shuts
    // the fetch gate and leaves the cache holding an empty page; adding one back
    // reopens it — and with every revalidation trigger off, SWR serves that
    // empty page rather than asking. The new task never appears and the row
    // claims its sub-tasks are "no longer here" while the count says otherwise.
    // Collapsing does not clear it either: the entry lives in the app-wide
    // provider.
    fetchWithAuth
      .mockResolvedValueOnce(subTaskResponse([task({ id: 'first' })]))
      .mockResolvedValue(subTaskResponse([task({ id: 'second' })]));
    const { rerender } = render(
      <Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />,
    );
    await screen.findByText('first');

    // The delete: the row goes, and the parent's counter with it.
    rerender(
      <Harness tasks={[task({ id: 'parent', subTaskCount: 0 })]} expanded={expandedFor('parent')} />,
    );
    // The re-add.
    rerender(
      <Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />,
    );

    await waitFor(() => expect(screen.queryByText('second')).not.toBeNull(), { timeout: 3000 });
    assert({
      given: 'a node whose sub-task count fell to zero and came back',
      should: 'refetch, and show the task that came back',
      actual: {
        shown: !!screen.queryByText('second'),
        gone: !!screen.queryByText('These sub-tasks are no longer here.'),
      },
      expected: { shown: true, gone: false },
    });
  });

  it('reloads a node whose cache says empty while its count says otherwise', async () => {
    // The unmount path, which an edge-detector alone cannot see: delete the last
    // sub-task, COLLAPSE the row (which unmounts the subtree), then use the row
    // menu's "Add sub-task" — offered precisely because the count is 0. The
    // subtree mounts fresh with the count already back at 1, over a cache
    // holding an empty page. There is no edge to observe.
    //
    // Staged as the resulting STATE rather than by driving the menu, because
    // that state is what the repair keys on however it arose: gate open (so the
    // count says there is a sub-task) while the cache holds pages with no rows.
    // An ordinary collapse and re-expand cannot produce it — those pages have
    // rows — which is what keeps that case from re-requesting.
    fetchWithAuth
      .mockResolvedValueOnce(subTaskResponse([]))
      .mockResolvedValue(subTaskResponse([task({ id: 'second' })]));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);

    await waitFor(() => expect(screen.queryByText('second')).not.toBeNull(), { timeout: 3000 });
    assert({
      given: 'a node whose cache contradicts its own sub-task count',
      should: 'refetch once and render what comes back',
      actual: {
        shown: !!screen.queryByText('second'),
        fetches: fetchWithAuth.mock.calls.length,
      },
      expected: { shown: true, fetches: 2 },
    });
  });

  it('does not spin when the server never agrees with the count', async () => {
    // A parent counter can be stale: the count says one sub-task and the server
    // keeps answering with none, so the contradiction the repair fires on is
    // still there after the repair.
    //
    // Honest about its reach: this pins that no loop occurs, and it passes with
    // the explicit once-per-open guard REMOVED — the effect's deps already stop
    // it, because an unchanged payload leaves `pages` at the same reference and
    // the effect never re-runs. The guard stays as insurance for a payload that
    // does change while still carrying no rows; that case is not staged here.
    fetchWithAuth.mockResolvedValue(subTaskResponse([]));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);

    await waitFor(() => expect(fetchWithAuth.mock.calls.length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 300));

    assert({
      given: 'a count the server never agrees with',
      should: 'settle at one repair rather than keep asking',
      actual: fetchWithAuth.mock.calls.length,
      expected: 2,
    });
  });

  it('keeps a row collapsible once its last sub-task is gone', async () => {
    // Deleting the last child drops subTaskCount to 0, which makes a row with
    // no description un-expandable — while it is still OPEN and its inline add
    // row is still on screen. The chevron would disappear and the user could
    // not close what they can see, and aria-expanded would vanish off a row
    // whose children are rendered.
    fetchWithAuth.mockResolvedValue(subTaskResponse([]));
    render(
      <Harness tasks={[task({ id: 'parent', subTaskCount: 0, hasContent: false })]} expanded={expandedFor('parent')} />,
    );

    assert({
      given: 'an expanded row whose count has fallen to zero, with no description',
      should: 'still offer the collapse control and still report itself expanded',
      actual: {
        collapse: !!screen.queryByRole('button', { name: /Collapse parent/i }),
        ariaExpanded: screen.getByText('parent').closest('tr')?.getAttribute('aria-expanded'),
      },
      expected: { collapse: true, ariaExpanded: 'true' },
    });
  });

  it('re-requests the failed FIRST page rather than paging past it', async () => {
    fetchWithAuth.mockRejectedValue(new Error('offline'));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);
    await screen.findByText('Could not load sub-tasks.');
    const before = fetchWithAuth.mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchWithAuth.mock.calls.length).toBeGreaterThan(before));

    const after = fetchWithAuth.mock.calls.slice(before).map((c) => String(c[0]));
    assert({
      given: 'a retry after the first page failed',
      should: 'ask for offset 0 again and not skip past it',
      // Honest about its own reach: this pins the OUTCOME, not the branch.
      // `loadMore` here produces the identical single request, because SWR will
      // not fetch page N+1 while page N is unresolved — so no assertion can
      // separate the two in this state. The next test is the one that does.
      actual: {
        refetchedFirst: after.some((u) => u.includes('offset=0')),
        pagedPast: after.some((u) => u.includes('offset=100')),
      },
      expected: { refetchedFirst: true, pagedPast: false },
    });
  });

  it('asks only for the page that failed when a LATER one did', async () => {
    // `retry` re-issues every loaded page against a route that lazily writes,
    // so the recovery for a later-page failure has to be the cheaper one.
    fetchWithAuth
      .mockResolvedValueOnce(subTaskResponse([task({ id: 'child' })], true))
      .mockRejectedValue(new Error('offline'));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);
    await screen.findByText('child');
    await userEvent.click(screen.getByRole('button', { name: 'Load more sub-tasks' }));
    await screen.findByText('Could not load the rest of the sub-tasks.');
    const before = fetchWithAuth.mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchWithAuth.mock.calls.length).toBeGreaterThan(before));

    assert({
      given: 'a retry after a later page failed, with the first page loaded',
      should: 'request only the missing page, never re-issue offset 0',
      actual: fetchWithAuth.mock.calls.slice(before).every(
        (c) => !String(c[0]).includes('offset=0'),
      ),
      expected: true,
    });
  });
});

describe('nested writes', () => {
  it('PATCHes the parent task page, not the viewed list', async () => {
    // The single most important assertion in the epic. `listPageId` for a
    // sub-task is its parent TASK's page; sending the root list's page id makes
    // the route's `existingTask.page.parentId !== pageId` check return 404.
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })]));
    patchMock.mockResolvedValue(task({ id: 'child', status: 'completed', updatedAt: 's1' }));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);
    await screen.findByText('child');

    await userEvent.click(screen.getByRole('checkbox', { name: /Complete child/i }));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    assert({
      given: "a click on a sub-task's checkbox",
      should: "address the parent task's page and the sub-task id",
      actual: [patchMock.mock.calls[0][0], patchMock.mock.calls[0][1]],
      expected: ['/api/pages/page-parent/tasks/child', { status: 'completed' }],
    });
  });

  it('creates an inline sub-task under the parent task page', async () => {
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })]));
    postMock.mockResolvedValue(task({ id: 'new', title: 'Fresh' }));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);
    await screen.findByText('child');

    await userEvent.type(screen.getByPlaceholderText('+ Add a sub-task…'), 'Fresh{Enter}');

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    assert({
      given: 'a title typed into the inline add row',
      should: "POST it under the parent task's page",
      actual: [postMock.mock.calls[0][0], postMock.mock.calls[0][1]],
      expected: ['/api/pages/page-parent/tasks', { title: 'Fresh' }],
    });
  });

  it('widens the window until a sub-task created past the loaded pages appears', async () => {
    // With more pages to load, the new task is at the end of the server's
    // ordering — i.e. in a page this cache does not hold. Refetching what it
    // holds cannot surface it, so the input clears, the badge goes up, and the
    // row is nowhere: the user retypes and creates a duplicate.
    fetchWithAuth
      .mockResolvedValueOnce(subTaskResponse([task({ id: 'child' })], true))
      .mockResolvedValueOnce(subTaskResponse([task({ id: 'child' })], true))
      .mockResolvedValue(subTaskResponse([task({ id: 'new', title: 'Fresh' })]));
    postMock.mockResolvedValue(task({ id: 'new', title: 'Fresh' }));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);
    await screen.findByText('child');

    await userEvent.type(screen.getByPlaceholderText('+ Add a sub-task…'), 'Fresh{Enter}');

    await waitFor(() => expect(screen.queryByText('Fresh')).not.toBeNull(), { timeout: 3000 });
    assert({
      given: 'a sub-task created onto a page the cache had not loaded',
      should: 'end up rendering it',
      actual: !!screen.queryByText('Fresh'),
      expected: true,
    });
  });

  it('bounds the reveal walk instead of paging a long sub-list all the way out', async () => {
    // The walk asks for the next page until the tail is loaded, and the tail of
    // a 2,000-sub-task list is twenty requests and two thousand rows away —
    // spent because somebody added one item, against a route that lazily
    // WRITES. Past the bound the row is one "Load more" away and the button
    // already says so.
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })], true));
    postMock.mockResolvedValue(task({ id: 'new', title: 'Fresh' }));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);
    await screen.findByText('child');

    await userEvent.type(screen.getByPlaceholderText('+ Add a sub-task…'), 'Fresh{Enter}');
    await waitFor(() => expect(fetchWithAuth.mock.calls.length).toBeGreaterThan(2));
    // Long enough that an unbounded walk would still be going — with the bound
    // removed this test does not fail, it HANGS, which is what the walk does.
    await new Promise((r) => setTimeout(r, 400));
    const settled = fetchWithAuth.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));

    assert({
      given: 'a sub-list that always reports another page',
      should: 'stop after a bounded number of pages rather than walk to the end',
      actual: {
        stopped: fetchWithAuth.mock.calls.length === settled,
        // 1 initial + 1 retry + at most MAX_REVEAL_PAGES walk pages.
        withinBound: settled <= 8,
      },
      expected: { stopped: true, withinBound: true },
    });
  });

  it('still surfaces a sub-task created after the first page failed', async () => {
    // No pages loaded at all, so there is nothing to append TO. `hasMore` reads
    // false here — the last loaded page is the one that never arrived — which
    // makes it exactly the wrong question: appending no-ops, the input clears,
    // the badge goes up and the row is nowhere.
    fetchWithAuth
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(subTaskResponse([task({ id: 'new', title: 'Fresh' })]));
    postMock.mockResolvedValue(task({ id: 'new', title: 'Fresh' }));
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 1 })]} expanded={expandedFor('parent')} />);
    await screen.findByText('Could not load sub-tasks.');

    await userEvent.type(screen.getByPlaceholderText('+ Add a sub-task…'), 'Fresh{Enter}');

    await waitFor(() => expect(screen.queryByText('Fresh')).not.toBeNull(), { timeout: 3000 });
    assert({
      given: 'a sub-task created while the cache holds no pages',
      should: 'refetch so the row appears rather than silently drop it',
      actual: !!screen.queryByText('Fresh'),
      expected: true,
    });
  });

  it('offers no inline add row without edit permission', async () => {
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })]));
    render(
      <Harness
        tasks={[task({ id: 'parent', subTaskCount: 1 })]}
        expanded={expandedFor('parent')}
        canEdit={false}
      />,
    );
    await screen.findByText('child');
    assert({
      given: 'a read-only viewer',
      should: 'not show the inline add row',
      actual: screen.queryByPlaceholderText('+ Add a sub-task…'),
      expected: null,
    });
  });
});

describe('sub-task counters', () => {
  it('tells the parent when a child completes', async () => {
    // The counters live on the PARENT row, in the cache one level up — a child
    // completing has to report the delta upward or a top-level "0/1" never moves.
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })]));
    patchMock.mockResolvedValue(task({ id: 'child', status: 'completed', completedAt: 'x', updatedAt: 's' }));
    const onCountDelta = vi.fn();
    render(
      <Harness
        tasks={[task({ id: 'parent', subTaskCount: 1 })]}
        expanded={expandedFor('parent')}
        onCountDelta={onCountDelta}
      />,
    );
    await screen.findByText('child');

    await userEvent.click(screen.getByRole('checkbox', { name: /Complete child/i }));

    await waitFor(() => expect(onCountDelta).toHaveBeenCalled());
    assert({
      given: 'a sub-task completed inline',
      should: "report one more completed to its parent's row",
      actual: onCountDelta.mock.calls[0][0],
      expected: { completed: 1 },
    });
  });

  it('counts a sub-task that arrives already complete as complete', async () => {
    // POST seeds the status from the list's own vocabulary, and a list with no
    // open status resolves to a done one — which the server stamps complete.
    // Counting it as open leaves the parent at n/(n+1) with no way back: the
    // completion guard refuses it, and this cache has no revalidation trigger.
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })]));
    postMock.mockResolvedValue(
      task({ id: 'new', title: 'Fresh', status: 'shipped', completedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const onCountDelta = vi.fn();
    render(
      <Harness
        tasks={[task({ id: 'parent', subTaskCount: 1 })]}
        expanded={expandedFor('parent')}
        onCountDelta={onCountDelta}
      />,
    );
    await screen.findByText('child');

    await userEvent.type(screen.getByPlaceholderText('+ Add a sub-task…'), 'Fresh{Enter}');

    await waitFor(() => expect(onCountDelta).toHaveBeenCalled());
    assert({
      given: 'a created sub-task the server returned already stamped complete',
      should: 'report it as both added and completed',
      actual: onCountDelta.mock.calls[0][0],
      expected: { total: 1, completed: 1 },
    });
  });

  it('does not move the parent counter when the toggle cannot actually complete', async () => {
    // A list with no done-group status. resolveToggleStatus deliberately returns
    // a slug from the other side rather than one the list does not define — the
    // write succeeds, so assuming it completed the task moves the parent's
    // counter for a transition the server never made. Status and completedAt
    // self-correct from the response; the counter lives in another cache and
    // nothing repairs it.
    const openOnly = [
      { id: 'c1', taskListId: 'sub', name: 'Backlog', slug: 'backlog', color: 'x', group: 'todo' as const, position: 0 },
      { id: 'c2', taskListId: 'sub', name: 'Doing', slug: 'doing', color: 'x', group: 'in_progress' as const, position: 1 },
    ];
    fetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({
        taskList: { id: 'sub', title: 'Sub', description: null, status: 'active', updatedAt: 'x' },
        tasks: [task({ id: 'child', status: 'backlog' })],
        statusConfigs: openOnly,
        hasMore: false,
      }),
    });
    patchMock.mockResolvedValue(task({ id: 'child', status: 'doing', completedAt: null, updatedAt: 's' }));
    const onCountDelta = vi.fn();
    render(
      <Harness
        tasks={[task({ id: 'parent', subTaskCount: 1 })]}
        expanded={expandedFor('parent')}
        onCountDelta={onCountDelta}
      />,
    );
    await screen.findByText('child');

    await userEvent.click(screen.getByRole('checkbox', { name: /Complete child/i }));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    assert({
      given: 'a completion toggle on a list that defines no done status',
      should: 'send a slug the list defines, and leave the parent counter alone',
      actual: {
        sent: (patchMock.mock.calls[0][1] as { status: string }).status,
        deltas: onCountDelta.mock.calls.length,
      },
      expected: { sent: 'doing', deltas: 0 },
    });
  });

  it('reports a decrement when a completed child is reopened', async () => {
    fetchWithAuth.mockResolvedValue(
      subTaskResponse([task({ id: 'child', status: 'completed', completedAt: 'x' })]),
    );
    patchMock.mockResolvedValue(task({ id: 'child', status: 'pending', completedAt: null, updatedAt: 's' }));
    const onCountDelta = vi.fn();
    render(
      <Harness
        tasks={[task({ id: 'parent', subTaskCount: 1, subTaskCompletedCount: 1 })]}
        expanded={expandedFor('parent')}
        onCountDelta={onCountDelta}
      />,
    );
    await screen.findByText('child');

    await userEvent.click(screen.getByRole('checkbox', { name: /Reopen child/i }));

    await waitFor(() => expect(onCountDelta).toHaveBeenCalled());
    assert({
      given: 'a completed sub-task reopened',
      should: 'report one fewer completed',
      actual: onCountDelta.mock.calls[0][0],
      expected: { completed: -1 },
    });
  });
});

describe('the fetch gate', () => {
  it('issues no request for a collapsed row', async () => {
    // A GET here lazily writes a task_lists row and its status configs.
    render(<Harness tasks={[task({ id: 'parent', subTaskCount: 3 })]} expanded={new Set()} />);
    await new Promise((r) => setTimeout(r, 30));
    assert({
      given: 'a task with sub-tasks that is not expanded',
      should: 'make no request at all',
      actual: fetchWithAuth.mock.calls.length,
      expected: 0,
    });
  });

  it('issues no request for an expanded leaf', async () => {
    render(<Harness tasks={[task({ id: 'leaf', hasContent: true, subTaskCount: 0 })]} expanded={expandedFor('leaf')} />);
    await new Promise((r) => setTimeout(r, 30));
    assert({
      given: 'an expanded task with content but no sub-tasks',
      should: 'render the document without fetching sub-tasks',
      actual: fetchWithAuth.mock.calls.length,
      expected: 0,
    });
  });
});
