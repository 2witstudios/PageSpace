// @vitest-environment jsdom
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { seededStatuses } from '../task-model/fixtures';
import { configsOf } from './task-list-tools';

describe('configsOf', () => {
  const statuses = seededStatuses.map((status, index) => (index === 1 ? { ...status, wipLimit: 3 } : status));

  test('the limit is left off', () => {
    assert({
      given: 'statuses where one column has a WIP limit',
      should: 'hand the manager rows with no wipLimit, so its PUT keeps the stored ones',
      actual: configsOf('l1', statuses).map((config) => 'wipLimit' in config),
      expected: [false, false, false, false],
    });
  });

  test('the rest of each row', () => {
    const [first] = configsOf('l1', statuses);
    assert({
      given: 'a list page and its statuses',
      should: 'keep every other field and name the list',
      actual: first,
      expected: { id: 'cfg-pending', slug: 'pending', name: 'To Do', color: 'bg-slate-100', group: 'todo', position: 0, taskListId: 'l1' },
    });
  });
});
