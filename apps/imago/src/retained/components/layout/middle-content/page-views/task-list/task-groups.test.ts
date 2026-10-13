import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { groupTasksByStatus } from './task-groups';
import type { TaskStatusConfig } from './task-list-types';

const status = (slug: string, name: string, group: TaskStatusConfig['group'], position: number): TaskStatusConfig => ({
  id: slug,
  taskListId: 'list',
  name,
  slug,
  color: '',
  group,
  position,
});

const configs: TaskStatusConfig[] = [
  status('todo', 'To Do', 'todo', 0),
  status('doing', 'In Progress', 'in_progress', 1),
  status('done', 'Done', 'done', 2),
];

const task = (id: string, status: string) => ({ id, status });

describe('groupTasksByStatus', () => {
  test('orders groups by the list status order and keeps each bucket in incoming order', () => {
    const groups = groupTasksByStatus(
      [task('a', 'done'), task('b', 'todo'), task('c', 'done'), task('d', 'doing')],
      configs,
    );
    assert({
      given: 'tasks interleaved across three statuses',
      should: 'emit To Do, In Progress, Done with each bucket in incoming order',
      actual: groups.map((g) => ({ key: g.key, label: g.label, ids: g.tasks.map((t) => t.id) })),
      expected: [
        { key: 'todo', label: 'To Do', ids: ['b'] },
        { key: 'doing', label: 'In Progress', ids: ['d'] },
        { key: 'done', label: 'Done', ids: ['a', 'c'] },
      ],
    });
  });

  test('marks only the done-group as isDone and leaves empty statuses out', () => {
    const groups = groupTasksByStatus([task('a', 'done'), task('b', 'todo')], configs);
    assert({
      given: 'a list with no in-progress tasks',
      should: 'flag the done group and omit the empty in-progress group',
      actual: groups.map((g) => ({ key: g.key, isDone: g.isDone })),
      expected: [
        { key: 'todo', isDone: false },
        { key: 'done', isDone: true },
      ],
    });
  });

  test('keeps tasks whose status the list does not define, after the defined groups', () => {
    const groups = groupTasksByStatus([task('a', 'stale'), task('b', 'todo')], configs);
    assert({
      given: 'a task with a status slug missing from the list',
      should: 'still group it, after the defined statuses, under its raw slug',
      actual: groups.map((g) => [g.key, g.label]),
      expected: [['todo', 'To Do'], ['stale', 'stale']],
    });
  });

  test('returns no groups for no tasks', () => {
    assert({
      given: 'an empty task list',
      should: 'return no groups',
      actual: groupTasksByStatus([], configs),
      expected: [],
    });
  });
});
