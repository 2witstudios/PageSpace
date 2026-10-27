import { describe, it, expect, vi } from 'vitest';
import { bindTaskHandlersToList, type LocatedTaskHandlers, type TaskItem } from '../task-list-types';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const task = (id: string): TaskItem => ({
  id,
  userId: 'u1',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: `page-${id}`,
  title: id,
  status: 'pending',
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const located = () => {
  const calls: Record<string, unknown[]> = {};
  const spy = (name: string) => vi.fn((...args: unknown[]) => { calls[name] = args; });
  const handlers: LocatedTaskHandlers = {
    onToggleComplete: spy('onToggleComplete'),
    onStatusChange: spy('onStatusChange'),
    onPriorityChange: spy('onPriorityChange'),
    onAssigneeChange: spy('onAssigneeChange'),
    onMultiAssigneeChange: spy('onMultiAssigneeChange'),
    onDueDateChange: spy('onDueDateChange'),
    onSaveTitle: spy('onSaveTitle'),
    onDelete: spy('onDelete'),
    onNavigate: spy('onNavigate'),
    onStartEdit: spy('onStartEdit'),
    onConfigureTriggers: spy('onConfigureTriggers'),
  };
  return { handlers, calls };
};

describe('bindTaskHandlersToList', () => {
  it('passes the list page id as the location, not the task id', () => {
    // The regression this guards: swapping the two produces a PATCH to
    // /api/pages/<taskId>/tasks/<listPageId>, which 404s on the parent check.
    const { handlers, calls } = located();
    const t = task('task-9');
    bindTaskHandlersToList(handlers, 'list-page').onStatusChange(t, 'done');
    assert({
      given: 'a status change on a bound handler',
      should: 'address the list page and the task separately, and pass the row itself',
      actual: calls.onStatusChange,
      expected: [{ listPageId: 'list-page', taskId: 'task-9' }, t, 'done'],
    });
  });

  it('derives the location for onToggleComplete from the task, and still passes the task', () => {
    const { handlers, calls } = located();
    const t = task('task-1');
    bindTaskHandlersToList(handlers, 'list-page').onToggleComplete(t);
    assert({
      given: 'a toggle on a bound handler',
      should: 'pass the location and the original task',
      actual: calls.onToggleComplete,
      expected: [{ listPageId: 'list-page', taskId: 'task-1' }, t],
    });
  });

  it('forwards delete with only the location', () => {
    const { handlers, calls } = located();
    bindTaskHandlersToList(handlers, 'list-page').onDelete('task-3');
    assert({
      given: 'a delete on a bound handler',
      should: 'address the right list',
      actual: calls.onDelete,
      expected: [{ listPageId: 'list-page', taskId: 'task-3' }],
    });
  });

  it('forwards multi-assignee changes with the location first', () => {
    const { handlers, calls } = located();
    const ids = [{ type: 'user' as const, id: 'u2' }];
    bindTaskHandlersToList(handlers, 'list-page').onMultiAssigneeChange?.('task-4', ids);
    assert({
      given: 'a multi-assignee change',
      should: 'pass the location then the assignee ids',
      actual: calls.onMultiAssigneeChange,
      expected: [{ listPageId: 'list-page', taskId: 'task-4' }, ids],
    });
  });

  it('passes through the task-only handlers unchanged', () => {
    const { handlers } = located();
    const bound = bindTaskHandlersToList(handlers, 'list-page');
    assert({
      given: 'handlers that take a task rather than a location',
      should: 'be forwarded by identity',
      actual: [
        bound.onNavigate === handlers.onNavigate,
        bound.onStartEdit === handlers.onStartEdit,
        bound.onConfigureTriggers === handlers.onConfigureTriggers,
      ],
      expected: [true, true, true],
    });
  });

  it('omits optional handlers the source does not provide', () => {
    const { handlers } = located();
    delete handlers.onMultiAssigneeChange;
    delete handlers.onConfigureTriggers;
    const bound = bindTaskHandlersToList(handlers, 'list-page');
    assert({
      given: 'a source with no multi-assignee or trigger handler',
      should: 'leave both undefined rather than binding a thrower',
      actual: ['onMultiAssigneeChange' in bound, 'onConfigureTriggers' in bound],
      expected: [false, false],
    });
  });
});
