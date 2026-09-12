import { describe, it } from 'vitest';
import { toDashboardTask } from '../to-dashboard-task';
import type { TaskItem, TaskStatusConfig } from '../task-list-types';
import { getStatusDisplay } from '@/components/tasks/task-helpers';
import { isCompletedStatus } from '../task-list-types';
import { assert } from '@/hooks/__tests__/riteway';

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

const config = (slug: string, over: Partial<TaskStatusConfig> = {}): TaskStatusConfig => ({
  id: `cfg-${slug}`,
  taskListId: 'list-1',
  name: slug,
  slug,
  color: '#000',
  group: 'todo',
  position: 0,
  ...over,
});

const ctx = { driveId: 'drive-1', taskListPageId: 'list-page-1' };

describe('status resolution', () => {
  it('prefers the list custom status config', () => {
    const configs = [config('shipped', { name: 'Shipped', color: 'bg-purple-100', group: 'done' })];
    const { statusLabel, statusColor, statusGroup } = toDashboardTask(
      task({ id: 't1', status: 'shipped' }), ctx, configs,
    );
    assert({
      given: 'a status matching a custom config slug',
      should: 'use the config name, color and group',
      actual: { statusLabel, statusColor, statusGroup },
      expected: { statusLabel: 'Shipped', statusColor: 'bg-purple-100', statusGroup: 'done' },
    });
  });

  it('falls back to the default status config', () => {
    const { statusLabel, statusGroup } = toDashboardTask(
      task({ id: 't1', status: 'in_progress' }), ctx, [],
    );
    assert({
      given: 'a default slug with no custom config',
      should: 'use the shared DEFAULT_STATUS_CONFIG entry',
      actual: { statusLabel, statusGroup },
      expected: { statusLabel: 'In Progress', statusGroup: 'in_progress' },
    });
  });

  it('falls back to the raw slug', () => {
    const { statusLabel, statusGroup } = toDashboardTask(
      task({ id: 't1', status: 'mystery' }), ctx, [],
    );
    assert({
      given: 'a slug in neither the custom nor the default configs',
      should: 'surface the raw slug in the todo group',
      actual: { statusLabel, statusGroup },
      expected: { statusLabel: 'mystery', statusGroup: 'todo' },
    });
  });

  // The whole point of the adapter: TaskCompactRow derives its checkbox from
  // getStatusDisplay(task).group, so a custom done-group status must read as
  // completed. Without the enrichment this falls back to 'todo' and the
  // checkbox silently renders unchecked for a finished task.
  it('makes a custom done-group status read as completed downstream', () => {
    const configs = [config('shipped', { name: 'Shipped', group: 'done' })];
    const adapted = toDashboardTask(task({ id: 't1', status: 'shipped' }), ctx, configs);
    assert({
      given: 'a custom status in the done group',
      should: 'resolve through getStatusDisplay as done',
      actual: getStatusDisplay(adapted).group,
      expected: 'done',
    });
  });

  // The row derives its checkbox from this group, while the filter, the table
  // and the completion guard all ask isCompletedStatus. If the two disagree the
  // row ticks a task the filter still calls active, and unticking it does
  // nothing visible. A list with its own vocabulary does not inherit the shared
  // defaults, so such a slug is an unknown status to every surface alike.
  it('treats a default done slug the list does not define as unknown, like the table', () => {
    const configs = [config('shipped', { name: 'Shipped', color: 'bg-purple-100', group: 'done' })];
    const adapted = toDashboardTask(task({ id: 't1', status: 'completed' }), ctx, configs);
    assert({
      given: 'a default done slug absent from the list vocabulary',
      should: 'show the raw slug, not be done, and agree with isCompletedStatus',
      actual: {
        statusLabel: adapted.statusLabel,
        statusGroup: adapted.statusGroup,
        rowSaysDone: getStatusDisplay(adapted).group === 'done',
        viewSaysDone: isCompletedStatus('completed', configs),
      },
      expected: {
        statusLabel: 'completed',
        statusGroup: 'todo',
        rowSaysDone: false,
        viewSaysDone: false,
      },
    });
  });

  // Same fallback the table uses: `statusConfigMap[status]?.label || status`.
  it('falls back to the slug when a custom config has an empty name', () => {
    const configs = [config('completed', { name: '', group: 'done' })];
    assert({
      given: 'a custom config whose name is empty',
      should: 'show the slug rather than an empty badge',
      actual: toDashboardTask(task({ id: 't1', status: 'completed' }), ctx, configs).statusLabel,
      expected: 'completed',
    });
  });
});

describe('shape normalisation', () => {
  it('injects the list context the page endpoint omits', () => {
    const { driveId, taskListPageId } = toDashboardTask(task({ id: 't1' }), ctx, []);
    assert({
      given: 'a task item and its list context',
      should: 'carry driveId and task list identity onto the adapted task',
      actual: { driveId, taskListPageId },
      expected: { driveId: 'drive-1', taskListPageId: 'list-page-1' },
    });
  });

  it('normalises absent relations to null', () => {
    const { assignee, assigneeAgent, user, page } = toDashboardTask(
      task({ id: 't1' }), ctx, [],
    );
    assert({
      given: 'a task item whose optional relations are absent',
      should: 'emit null rather than undefined for each',
      actual: { assignee, assigneeAgent, user, page },
      expected: { assignee: null, assigneeAgent: null, user: null, page: null },
    });
  });

  it('gives an untitled agent assignee a readable title', () => {
    const { assigneeAgent } = toDashboardTask(
      task({ id: 't1', assigneeAgent: { id: 'a1', title: null, type: 'AGENT' } }), ctx, [],
    );
    assert({
      given: 'an agent assignee with a null title',
      should: 'substitute a placeholder so the task does not look unassigned',
      actual: assigneeAgent,
      expected: { id: 'a1', title: 'Untitled agent', type: 'AGENT' },
    });
  });

  it('takes the linked page title from the task title', () => {
    const { page } = toDashboardTask(
      task({ id: 't1', title: 'Ship it', page: { id: 'p1', type: 'TASK_LIST', isTrashed: false, position: 0 } }),
      ctx, [],
    );
    assert({
      given: 'a linked page carrying no title of its own',
      should: "use the task's title, which is the linked page's title",
      actual: page,
      expected: { id: 'p1', title: 'Ship it', isTrashed: false },
    });
  });
});
