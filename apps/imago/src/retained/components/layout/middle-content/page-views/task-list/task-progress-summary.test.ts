import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { TaskItem, TaskStatusConfig } from './task-list-types';
import { formatTaskProgress, summarizeTaskProgress } from './task-progress-summary';

const configs: TaskStatusConfig[] = [
  { id: '1', taskListId: 'l', name: 'To Do', slug: 'todo', color: '', group: 'todo', position: 0 },
  { id: '2', taskListId: 'l', name: 'Done', slug: 'done', color: '', group: 'done', position: 1 },
];

const now = new Date('2026-10-12T12:00:00Z');

const task = (overrides: Partial<TaskItem>): TaskItem => ({
  id: 't', userId: 'u', assigneeId: null, assigneeAgentId: null, pageId: null, title: 'Task',
  status: 'todo', priority: 'medium', position: 0, dueDate: null, completedAt: null,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...overrides,
} as TaskItem);

describe('summarizeTaskProgress', () => {
  test('counts done tasks against the total', () => {
    const summary = summarizeTaskProgress(
      [task({ id: 'a', status: 'done' }), task({ id: 'b' }), task({ id: 'c', status: 'done' })],
      configs,
      now,
    );
    assert({
      given: 'three tasks, two in a done-group status',
      should: 'count 2 done of 3 total',
      actual: { done: summary.done, total: summary.total },
      expected: { done: 2, total: 3 },
    });
  });

  test('counts open tasks with an agent assignee, legacy or multi-assignee', () => {
    const summary = summarizeTaskProgress(
      [
        task({ id: 'a', assigneeAgentId: 'agent-1' }),
        task({ id: 'b', assignees: [{ id: 'x', taskId: 'b', userId: null, agentPageId: 'agent-2' }] }),
        task({ id: 'c', assignees: [{ id: 'y', taskId: 'c', userId: 'user-1', agentPageId: null }] }),
        task({ id: 'd', status: 'done', assigneeAgentId: 'agent-3' }),
      ],
      configs,
      now,
    );
    assert({
      given: 'two open agent-assigned tasks, a human-assigned task and a done agent-assigned task',
      should: 'count only the two open agent-assigned tasks',
      actual: summary.onAgents,
      expected: 2,
    });
  });

  test('counts open tasks past their due date, not done ones', () => {
    const summary = summarizeTaskProgress(
      [
        task({ id: 'a', dueDate: '2026-10-09T00:00:00Z' }),
        task({ id: 'b', dueDate: '2026-10-20T00:00:00Z' }),
        task({ id: 'c', status: 'done', dueDate: '2026-10-01T00:00:00Z' }),
        task({ id: 'd', dueDate: null }),
      ],
      configs,
      now,
    );
    assert({
      given: 'one overdue open task, one future task, one overdue done task and one without a date',
      should: 'count exactly one overdue task',
      actual: summary.overdue,
      expected: 1,
    });
  });

  test('returns zeros for an empty list', () => {
    assert({
      given: 'no tasks',
      should: 'summarise to zero counts',
      actual: summarizeTaskProgress([], configs, now),
      expected: { done: 0, total: 0, onAgents: 0, overdue: 0 },
    });
  });

  test('formats the progress line with the board separators', () => {
    assert({
      given: 'a summary of 4 done of 12, 2 on agents and 1 overdue',
      should: 'read "4 of 12 done · 2 on agents · 1 overdue"',
      actual: formatTaskProgress({ done: 4, total: 12, onAgents: 2, overdue: 1 }),
      expected: '4 of 12 done · 2 on agents · 1 overdue',
    });
  });
});
