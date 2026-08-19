/**
 * What the expansion actually renders for the two cases a user can hit but a pure-function
 * test cannot see: a sub-task whose linked page is gone, and a fetch that failed.
 *
 * Both are honesty bugs rather than crashes — a dead link that looks live, and an empty list
 * under a header that just claimed there are N sub-tasks — so they have to be asserted against
 * rendered output.
 *
 * Rendered through TaskRowDescription rather than TaskSubTaskList directly, even though the
 * logic lives in the latter: what matters is what the assembled expansion puts on screen, and
 * this way the test survives the two halves being rearranged (which is what the epic's
 * sub-tasks-vs-document branch will do next).
 */
import React from 'react';
import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { render, screen } from '@testing-library/react';
import type { TaskItem } from '../task-list-types';
import type { UseTaskSubTasksResult } from '../useTaskSubTasks';

const { useTaskSubTasks } = vi.hoisted(() => ({ useTaskSubTasks: vi.fn() }));
vi.mock('../useTaskSubTasks', () => ({ useTaskSubTasks }));
vi.mock('@/hooks/usePageContent', () => ({
  usePageContent: () => ({ content: '<p>doc</p>', isLoading: false }),
}));
// The expansion's document half is a dynamically imported rich editor; it is not what these
// cases are about, and rendering it drags in the whole tiptap stack.
vi.mock('next/dynamic', () => ({ default: () => function RichEditorStub() { return null; } }));

import { TaskRowDescription } from '../TaskRowDescription';

const subTask = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: 'st1',
  userId: 'u1',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: 'child-page',
  title: 'A sub-task',
  status: 'pending',
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const parentTask = (): TaskItem => subTask({ id: 'parent', pageId: 'parent-page', title: 'Parent', subTaskCount: 1 });

const hookResult = (over: Partial<UseTaskSubTasksResult> = {}): UseTaskSubTasksResult => ({
  subTasks: [],
  statusConfigs: [],
  hasMore: false,
  isLoading: false,
  isLoadingMore: false,
  error: undefined,
  loadMore: vi.fn(),
  retry: vi.fn(),
  ...over,
});

beforeEach(() => { useTaskSubTasks.mockReset(); });

describe('TaskRowDescription sub-task rows', () => {
  it('links a sub-task that has a linked page', () => {
    useTaskSubTasks.mockReturnValue(hookResult({ subTasks: [subTask()] }));
    render(<TaskRowDescription task={parentTask()} driveId="drive-1" />);

    assert({
      given: 'a sub-task with a linked page',
      should: 'render it as a drive-scoped link to that page',
      actual: screen.getByRole('link', { name: 'A sub-task' }).getAttribute('href'),
      expected: '/dashboard/drive-1/child-page',
    });
  });

  it('does not link a sub-task whose linked page is missing', () => {
    useTaskSubTasks.mockReturnValue(hookResult({ subTasks: [subTask({ pageId: null })] }));
    render(<TaskRowDescription task={parentTask()} driveId="drive-1" />);

    assert({
      given: 'a sub-task with a null pageId',
      should: 'still show its title, but never as a link to /dashboard/drive-1/null',
      actual: {
        titleShown: !!screen.getByText('A sub-task'),
        links: screen.queryAllByRole('link').length,
      },
      expected: { titleShown: true, links: 0 },
    });
  });

  it('says so when the sub-task fetch failed', () => {
    useTaskSubTasks.mockReturnValue(hookResult({ error: new Error('boom') }));
    render(<TaskRowDescription task={parentTask()} driveId="drive-1" />);

    assert({
      given: 'a header claiming 1 sub-task and a failed fetch',
      should: 'explain the failure rather than render an empty list that reads as "none"',
      actual: !!screen.getByText('Could not load sub-tasks.'),
      expected: true,
    });
  });

  it('does not leave a bare count standing when the sub-tasks are gone', () => {
    // subTaskCount rode in on the parent list's response; the children can be trashed between
    // that response and this expansion. An empty list under "1 sub-task" reads as a lie.
    useTaskSubTasks.mockReturnValue(hookResult({ subTasks: [] }));
    render(<TaskRowDescription task={parentTask()} driveId="drive-1" />);

    assert({
      given: 'a header claiming 1 sub-task and a successful fetch that returned none',
      should: 'explain the discrepancy rather than render nothing under the count',
      actual: !!screen.getByText('These sub-tasks are no longer here.'),
      expected: true,
    });
  });

  it('offers a way back when a later page failed', () => {
    // Rows already on screen, plus a standing error: nothing retries on its own, so the
    // control has to say that pressing it is the way back — and it must not be disabled.
    useTaskSubTasks.mockReturnValue(hookResult({
      subTasks: [subTask()],
      hasMore: true,
      error: new Error('network went away'),
    }));
    render(<TaskRowDescription task={parentTask()} driveId="drive-1" />);

    const button = screen.getByRole('button');
    assert({
      given: 'a failed later page with rows already shown',
      should: 'say only the rest failed, and offer an enabled retry rather than a stuck spinner',
      actual: {
        message: !!screen.getByText('Could not load the rest of the sub-tasks.'),
        label: button.textContent,
        disabled: (button as HTMLButtonElement).disabled,
      },
      expected: { message: true, label: 'Try again', disabled: false },
    });
  });

  it('offers a way back when the FIRST page failed and there is no Load more', () => {
    const retry = vi.fn();
    useTaskSubTasks.mockReturnValue(hookResult({
      subTasks: [],
      hasMore: false,
      error: new Error('network went away'),
      retry,
    }));
    render(<TaskRowDescription task={parentTask()} driveId="drive-1" />);

    screen.getByRole('button', { name: 'Try again' }).click();

    assert({
      given: 'a failed first page, where hasMore is false and Load more would never render',
      should: 'still offer a control, and wire it to retry rather than to paging forward',
      actual: { retried: retry.mock.calls.length },
      expected: { retried: 1 },
    });
  });

  it('reports what is actually in the list once it is complete', () => {
    // subTaskCount rode in on the parent list's response, which revalidates; this list does
    // not. When the list is settled and complete it is the fresher of the two, so the header
    // must not outrank the rows under it.
    useTaskSubTasks.mockReturnValue(hookResult({ subTasks: [subTask(), subTask({ id: 'st2' })] }));
    render(<TaskRowDescription task={{ ...parentTask(), subTaskCount: 5 }} driveId="drive-1" />);

    assert({
      given: 'a stale parent count of 5 over a complete list of 2',
      should: 'report 2, not 5',
      actual: { two: !!screen.getByText('2 sub-tasks'), five: screen.queryByText('5 sub-tasks') },
      expected: { two: true, five: null },
    });
  });

  it('keeps reporting the total while the list is still partial', () => {
    useTaskSubTasks.mockReturnValue(hookResult({ subTasks: [subTask()], hasMore: true }));
    render(<TaskRowDescription task={{ ...parentTask(), subTaskCount: 5 }} driveId="drive-1" />);

    assert({
      given: 'one page loaded of a longer list',
      should: 'still report the total, because the rows are deliberately partial',
      actual: !!screen.getByText('5 sub-tasks'),
      expected: true,
    });
  });

  it('re-requests only the missing page when a later page failed', () => {
    // retry() is SWR revalidate-all: using it here would re-issue every loaded page against a
    // route that writes. Paging forward asks only for the one that is missing.
    const retry = vi.fn();
    const loadMore = vi.fn();
    useTaskSubTasks.mockReturnValue(hookResult({
      subTasks: [subTask()],
      hasMore: true,
      error: new Error('network went away'),
      retry,
      loadMore,
    }));
    render(<TaskRowDescription task={parentTask()} driveId="drive-1" />);

    screen.getByRole('button', { name: 'Try again' }).click();

    assert({
      given: 'a failure that arrived after some rows had already loaded',
      should: 'page forward rather than revalidate every page already fetched',
      actual: { loadMore: loadMore.mock.calls.length, retry: retry.mock.calls.length },
      expected: { loadMore: 1, retry: 0 },
    });
  });

  it('stays quiet when the fetch succeeded', () => {
    useTaskSubTasks.mockReturnValue(hookResult({ subTasks: [subTask()] }));
    render(<TaskRowDescription task={parentTask()} driveId="drive-1" />);

    assert({
      given: 'a successful fetch',
      should: 'show no failure message',
      actual: screen.queryByText('Could not load sub-tasks.'),
      expected: null,
    });
  });
});
