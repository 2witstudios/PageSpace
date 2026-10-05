import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  MAX_LEVELS,
  allTasks,
  canNestUnder,
  completionRefusal,
  doneStatus,
  dueTone,
  isDone,
  isDoneStatus,
  listProgress,
  locate,
  openStatus,
  progress,
  seedStatus,
  statusOf,
  withSubtasks,
} from './task-tree';
import { list, parent, seededStatuses, task } from '../task-model/fixtures';
import type { TaskStatus } from '../task-model/task';

const status = (slug: string, group: TaskStatus['group'], position: number): TaskStatus => ({
  id: `cfg-${slug}`,
  slug,
  name: slug,
  color: '',
  group,
  position,
});

/** root → a → b → c → d: five levels, the deepest PageSpace nests. */
const fiveDeep = () =>
  list('root', [parent('a', [parent('b', [parent('c', [parent('d', [task('e')])])])]), task('z')]);

describe('locate()', () => {
  test('nested', () => {
    const root = fiveDeep();
    const found = locate(root, 'e');

    assert({
      given: 'a task five levels down',
      should: 'give the path of tasks down to it',
      actual: found?.path.map((entry) => entry.id),
      expected: ['a', 'b', 'c', 'd', 'e'],
    });

    assert({
      given: 'a task five levels down',
      should: 'give the lists from the root down to the one holding it',
      actual: found?.lists.map((entry) => entry.pageId),
      expected: ['root', 'page-a', 'page-b', 'page-c', 'page-d'],
    });
  });

  test('top level and missing', () => {
    assert({
      given: 'a top-level task',
      should: 'be held by the root list',
      actual: locate(fiveDeep(), 'z')?.lists.map((entry) => entry.pageId),
      expected: ['root'],
    });

    assert({
      given: 'an id no list holds',
      should: 'find nothing',
      actual: locate(fiveDeep(), 'nope'),
      expected: undefined,
    });
  });
});

describe('isDoneStatus()', () => {
  test('by group', () => {
    assert({
      given: 'a status in the done group',
      should: 'be done, whatever its slug',
      actual: isDoneStatus([status('shipped', 'done', 0)], 'shipped'),
      expected: true,
    });

    assert({
      given: 'a slug the list does not define',
      should: 'not be done',
      actual: isDoneStatus(seededStatuses, 'shipped'),
      expected: false,
    });
  });

  test('a list with no statuses', () => {
    assert({
      given: 'a list with no statuses and the slug "completed"',
      should: 'be done, as the server’s fallback decides',
      actual: isDoneStatus([], 'completed'),
      expected: true,
    });

    assert({
      given: 'a list with no statuses and any other slug',
      should: 'not be done',
      actual: isDoneStatus([], 'pending'),
      expected: false,
    });
  });
});

describe('isDone() and statusOf()', () => {
  test('lookup', () => {
    const root = list('root', [task('t', { status: 'completed' })]);

    assert({
      given: 'a task in a done status of its list',
      should: 'be done',
      actual: isDone(root, root.tasks[0]!),
      expected: true,
    });

    assert({
      given: 'a slug the list defines',
      should: 'give its status',
      actual: statusOf(root, 'blocked')?.name,
      expected: 'Blocked',
    });

    assert({
      given: 'a slug the list does not define',
      should: 'give nothing rather than guess',
      actual: statusOf(root, 'shipped'),
      expected: undefined,
    });
  });
});

describe('openStatus() and doneStatus()', () => {
  test('the seeded vocabulary', () => {
    assert({
      given: 'PageSpace’s seeded statuses',
      should: 'reopen to the first to-do and complete to the first done',
      actual: [openStatus(seededStatuses), doneStatus(seededStatuses)],
      expected: ['pending', 'completed'],
    });
  });

  test('order is by position', () => {
    const statuses = [status('later', 'todo', 5), status('first', 'todo', 1), status('end', 'done', 9), status('ok', 'done', 2)];

    assert({
      given: 'statuses listed out of position order',
      should: 'pick by position, not by listing',
      actual: [openStatus(statuses), doneStatus(statuses)],
      expected: ['first', 'ok'],
    });
  });

  test('a lopsided vocabulary', () => {
    const noTodo = [status('doing', 'in_progress', 0), status('done', 'done', 1)];
    const allDone = [status('a', 'done', 0), status('b', 'done', 1)];
    const noDone = [status('todo', 'todo', 0), status('doing', 'in_progress', 1)];

    assert({
      given: 'no to-do status',
      should: 'reopen to the first status that is not done',
      actual: openStatus(noTodo),
      expected: 'doing',
    });

    assert({
      given: 'only done statuses',
      should: 'reopen to the first status, as the server does',
      actual: openStatus(allDone),
      expected: 'a',
    });

    assert({
      given: 'no done status',
      should: 'complete to the last status, as the server does',
      actual: doneStatus(noDone),
      expected: 'doing',
    });
  });

  test('no statuses', () => {
    assert({
      given: 'a list with no statuses',
      should: 'use the slugs the server falls back to',
      actual: [openStatus([]), doneStatus([])],
      expected: ['pending', 'completed'],
    });
  });
});

describe('seedStatus()', () => {
  test('the server’s default', () => {
    assert({
      given: 'a list that defines "pending" as not done',
      should: 'start new tasks there, as the create route does',
      actual: seedStatus([status('doing', 'in_progress', 0), status('pending', 'todo', 1)]),
      expected: 'pending',
    });

    assert({
      given: 'a list that regrouped "pending" into done',
      should: 'start new tasks in its open status instead',
      actual: seedStatus([status('pending', 'done', 0), status('icebox', 'todo', 1)]),
      expected: 'icebox',
    });

    assert({
      given: 'a list without "pending"',
      should: 'start new tasks in its open status',
      actual: seedStatus([status('building', 'in_progress', 1), status('icebox', 'todo', 0)]),
      expected: 'icebox',
    });
  });
});

describe('completionRefusal()', () => {
  test('open subtasks', () => {
    const blocked = task('p', { subTaskCount: 3, subTaskCompletedCount: 1 });

    assert({
      given: 'a parent with 2 of 3 subtasks open, moving to a done status',
      should: 'refuse in the server’s words',
      actual: completionRefusal(seededStatuses, blocked, 'completed'),
      expected: 'Complete all sub-tasks first (2 of 3 remaining)',
    });

    assert({
      given: 'the same parent moving between open statuses',
      should: 'allow it',
      actual: completionRefusal(seededStatuses, blocked, 'blocked'),
      expected: null,
    });
  });

  test('already done', () => {
    const done = task('p', { status: 'completed', completedAt: '2026-10-01T00:00:00.000Z', subTaskCount: 1, subTaskCompletedCount: 0 });

    assert({
      given: 'a done parent that has since gained an open subtask, set to done again',
      should: 'still refuse, because the server re-checks every move into done',
      actual: completionRefusal(seededStatuses, done, 'completed'),
      expected: 'Complete all sub-tasks first (1 of 1 remaining)',
    });
  });

  test('nothing open', () => {
    assert({
      given: 'a parent whose subtasks are all complete',
      should: 'allow completing it',
      actual: completionRefusal(seededStatuses, task('p', { subTaskCount: 2, subTaskCompletedCount: 2 }), 'completed'),
      expected: null,
    });

    assert({
      given: 'a leaf task',
      should: 'allow completing it',
      actual: completionRefusal(seededStatuses, task('p'), 'completed'),
      expected: null,
    });
  });

  test('a list with no statuses', () => {
    assert({
      given: 'a list with no statuses, a blocked parent and the slug "completed"',
      should: 'refuse, as the server’s fallback path does',
      actual: completionRefusal([], task('p', { subTaskCount: 1 }), 'completed'),
      expected: 'Complete all sub-tasks first (1 of 1 remaining)',
    });
  });
});

describe('progress() and listProgress()', () => {
  test('counts', () => {
    const done = { status: 'completed', completedAt: '2026-10-01T00:00:00.000Z' };
    const root = list('root', [parent('a', [task('a1', done), task('a2')]), task('b', done)]);

    assert({
      given: 'a parent with one of two subtasks complete',
      should: 'count its direct subtasks',
      actual: progress(root.tasks[0]!),
      expected: { done: 1, total: 2 },
    });

    assert({
      given: 'a list with loaded subtasks',
      should: 'count every task at every level, each by its own list’s statuses',
      actual: listProgress(root),
      expected: { done: 2, total: 4 },
    });
  });

  test('allTasks()', () => {
    assert({
      given: 'a five-level list',
      should: 'walk every task depth first',
      actual: allTasks(fiveDeep()).map((entry) => entry.id),
      expected: ['a', 'b', 'c', 'd', 'e', 'z'],
    });
  });
});

describe('canNestUnder()', () => {
  test('five levels', () => {
    assert({
      given: 'PageSpace’s nesting cap',
      should: 'be five levels',
      actual: MAX_LEVELS,
      expected: 5,
    });

    assert({
      given: 'a task at level 4',
      should: 'take subtasks, which land at level 5',
      actual: canNestUnder(4),
      expected: true,
    });

    assert({
      given: 'a task at level 5',
      should: 'take no subtasks',
      actual: canNestUnder(5),
      expected: false,
    });
  });
});

describe('withSubtasks()', () => {
  test('attaching a loaded list', () => {
    const root = list('root', [parent('a', [task('b')]), task('z')]);
    const loaded = list('page-b', [task('c')]);
    const next = withSubtasks(root, 'page-b', loaded);

    assert({
      given: 'subtasks loaded for a nested task’s page',
      should: 'hang them under that task',
      actual: locate(next, 'c')?.path.map((entry) => entry.id),
      expected: ['a', 'b', 'c'],
    });

    assert({
      given: 'a task the attach did not touch',
      should: 'keep it as it was',
      actual: next.tasks[1] === root.tasks[1],
      expected: true,
    });
  });
});

describe('dueTone()', () => {
  test('tones', () => {
    const today = '2026-10-05';

    assert({
      given: 'an open task due yesterday',
      should: 'read overdue',
      actual: dueTone('2026-10-04T12:00:00.000Z', today, false),
      expected: 'overdue',
    });

    assert({
      given: 'an open task due in three days',
      should: 'read soon',
      actual: dueTone('2026-10-08T00:00:00.000Z', today, false),
      expected: 'soon',
    });

    assert({
      given: 'an open task due next week',
      should: 'read later',
      actual: dueTone('2026-10-12T00:00:00.000Z', today, false),
      expected: 'later',
    });

    assert({
      given: 'a done task due last week',
      should: 'read later: a done task is never overdue',
      actual: dueTone('2026-09-28T00:00:00.000Z', today, true),
      expected: 'later',
    });
  });
});
