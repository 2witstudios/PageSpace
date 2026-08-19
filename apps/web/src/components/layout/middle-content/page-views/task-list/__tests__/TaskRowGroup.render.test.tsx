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
import { render, screen, waitFor } from '@testing-library/react';
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
const { rootNodePath, makeNodePath } = await import('../task-tree-core');
const { TaskWriteProvider } = await import('@/lib/tasks/task-write-context');

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

const subTaskResponse = (tasks: TaskItem[]) => ({
  ok: true,
  json: async () => ({
    taskList: { id: 'sub', title: 'Sub', description: null, status: 'active', updatedAt: 'x' },
    tasks,
    statusConfigs: CONFIGS,
    hasMore: false,
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

function Harness({
  tasks, expanded, canEdit = true, handlers = noopHandlers(),
}: {
  tasks: TaskItem[];
  expanded: Set<string>;
  canEdit?: boolean;
  handlers?: LocatedTaskHandlers;
}) {
  const rootPath = rootNodePath(ROOT_PAGE);
  const tree = {
    canEdit,
    driveId: 'drive-1',
    rootStatusConfigs: CONFIGS,
    onNavigate: vi.fn(),
    onStartEdit: vi.fn(),
    openTriggerDialog: vi.fn(),
    expandedPaths: expanded,
    toggleExpanded: vi.fn(),
    editingTaskId: null,
    editingTitle: '',
    onEditingTitleChange: vi.fn(),
    onCancelEdit: vi.fn(),
  };
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TaskWriteProvider currentUserId="user-me" revalidateAll={vi.fn()}>
        <TaskTreeProvider value={tree}>
          <table>
            <tbody data-testid="rows">
              {tasks.map((t) => (
                <TaskRowGroup
                  key={t.id}
                  task={t}
                  depth={0}
                  listPageId={ROOT_PAGE}
                  path={makeNodePath(rootPath, t.id)}
                  handlers={handlers}
                  statusConfigs={CONFIGS}
                />
              ))}
            </tbody>
          </table>
        </TaskTreeProvider>
      </TaskWriteProvider>
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

  it('gives an expandable row aria-expanded and a leaf none', async () => {
    fetchWithAuth.mockResolvedValue(subTaskResponse([task({ id: 'child' })]));
    render(
      <Harness
        tasks={[task({ id: 'parent', subTaskCount: 1 }), task({ id: 'leaf' })]}
        expanded={expandedFor('parent')}
      />,
    );
    await screen.findByText('child');

    assert({
      given: 'an expanded parent, its leaf child, and a top-level leaf',
      should: 'expose aria-expanded only where expansion is possible',
      actual: [
        screen.getByText('child').closest('tr')?.hasAttribute('aria-expanded'),
        screen.getByText('leaf').closest('tr')?.hasAttribute('aria-expanded'),
      ],
      expected: [false, false],
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
