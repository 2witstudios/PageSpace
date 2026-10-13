import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { taskRoute } from './task-route';

const lists = [
  { pageId: 'l1', title: 'Launch' },
  { pageId: 'l2', title: 'Hiring' },
];

describe('taskRoute()', () => {
  test('a list', () => {
    assert({
      given: 'the id of one of the drive’s task lists',
      should: 'open the list, without asking where it sits',
      actual: taskRoute('l2', lists, undefined),
      expected: { kind: 'list', list: { pageId: 'l2', title: 'Hiring' } },
    });
  });

  test('a task', () => {
    assert({
      given: 'a subtask’s page under a task in list l1',
      should: 'open the task in the list nearest above it',
      actual: taskRoute(
        'page-a',
        lists,
        [
          { id: 'folder', title: 'Work' },
          { id: 'l1', title: 'Launch' },
          { id: 'page-p', title: 'Plan' },
          { id: 'page-a', title: 'Draft' },
        ],
      ),
      expected: { kind: 'task', list: { pageId: 'l1', title: 'Launch' } },
    });
  });

  test('a list nested in a list', () => {
    assert({
      given: 'a task under list l2, which itself sits under list l1',
      should: 'open it in l2, the list holding it',
      actual: taskRoute('page-a', lists, [
        { id: 'l1', title: 'Launch' },
        { id: 'l2', title: 'Hiring' },
        { id: 'page-a', title: 'Draft' },
      ]),
      expected: { kind: 'task', list: { pageId: 'l2', title: 'Hiring' } },
    });
  });

  test('still loading', () => {
    assert({
      given: 'the drive’s lists, or the page’s place, not loaded yet',
      should: 'wait',
      actual: [taskRoute('l1', undefined, undefined), taskRoute('page-a', lists, undefined)],
      expected: [{ kind: 'loading' }, { kind: 'loading' }],
    });
  });

  test('not a task', () => {
    assert({
      given: 'a page under no task list, a list id only as the page itself, or a place that failed to load',
      should: 'find nothing to open',
      actual: [
        taskRoute('doc', lists, [
          { id: 'folder', title: 'Work' },
          { id: 'doc', title: 'Notes' },
        ]),
        taskRoute('l9', lists, [{ id: 'l9', title: 'Elsewhere' }]),
        taskRoute('page-a', lists, null),
      ],
      expected: [{ kind: 'missing' }, { kind: 'missing' }, { kind: 'missing' }],
    });
  });
});
