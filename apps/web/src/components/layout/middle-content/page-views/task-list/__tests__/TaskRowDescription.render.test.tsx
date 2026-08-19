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
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

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
