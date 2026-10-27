import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { taskItem, taskListResponse } from '../task-model/fixtures';
import { taskListFrom } from '../task-model/from-api';
import { siblingGroups } from './sibling-groups';

const href = (pageId: string) => `/d1/tasks/${pageId}`;

describe('siblingGroups', () => {
  test('a task’s list, grouped by the list’s statuses in its order', () => {
    const tree = taskListFrom(
      'l1',
      'Launch',
      taskListResponse([
        taskItem('a', { status: 'completed', position: 0 }),
        taskItem('b', { status: 'pending', position: 1 }),
        taskItem('c', { status: 'in_progress', position: 2 }),
        taskItem('d', { status: 'pending', position: 3 }),
      ]),
    );
    assert({
      given: 'a list with two open tasks, one under way and one done, and the second open task open',
      should: 'group the tasks by status in status order, marking only the open task as current',
      actual: siblingGroups(tree, 'page-d', href, '2026-10-12')?.map((group) => [
        group.name,
        group.rows.map((row) => [row.title, row.current]),
      ]),
      expected: [
        ['To Do', [['Task b', false], ['Task d', true]]],
        ['In Progress', [['Task c', false]]],
        ['Done', [['Task a', false]]],
      ],
    });
  });

  test('a task whose status the list does not name', () => {
    const tree = taskListFrom('l1', 'Launch', taskListResponse([taskItem('a', { status: 'archived', position: 0 })]));
    assert({
      given: 'a task in a status the list does not have',
      should: 'keep it in a last group rather than drop it',
      actual: siblingGroups(tree, 'page-a', href, '2026-10-12')?.map((group) => group.name),
      expected: ['Other'],
    });
  });

  test('a page that is not in the list', () => {
    const tree = taskListFrom('l1', 'Launch', taskListResponse([taskItem('a')]));
    assert({
      given: 'a page no task in the list has',
      should: 'name no siblings',
      actual: siblingGroups(tree, 'page-zz', href, '2026-10-12'),
      expected: undefined,
    });
  });
});
