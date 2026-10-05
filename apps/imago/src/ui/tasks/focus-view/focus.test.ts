import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { list, parent, task } from '../task-model/fixtures';
import type { TaskList } from '../task-model/task';
import { doneToday, frontier, sameLocalDay } from './focus';

/** Local 09:00 on a day, whatever zone the suite runs in. */
const at = (day: number, hour = 9): Date => new Date(2026, 9, day, hour);
const stamp = (day: number, hour = 9): string => at(day, hour).toISOString();

/**
 * l1 "Launch": parent p (open leaf a, done leaf b, parent c holding open
 * leaf c1), a loose open leaf z and a loose done leaf y.
 */
const launch = (): TaskList =>
  list(
    'l1',
    [
      parent(
        'p',
        [
          task('a', { title: 'Draft copy' }),
          task('b', { title: 'Pick date', status: 'completed', completedAt: stamp(5) }),
          parent('c', [task('c1', { title: 'Call caterer' })], { title: 'Food' }),
        ],
        { title: 'Plan launch' },
      ),
      task('z', { title: 'Book venue' }),
      task('y', { title: 'Old chore', status: 'completed', completedAt: stamp(4) }),
    ],
    { title: 'Launch' },
  );

const shape = (root: TaskList) =>
  frontier(root).map((group) => ({
    id: group.id,
    heading: group.heading,
    list: group.list.pageId,
    tasks: group.tasks.map((entry) => entry.id),
  }));

describe('frontier()', () => {
  test('open leaves by parent', () => {
    assert({
      given: 'a list with nested parents, open and done leaves',
      should: 'group each open leaf under its own parent, loose ones under the list, never a parent or a done leaf',
      actual: shape(launch()),
      expected: [
        { id: 'p', heading: 'Plan launch', list: 'page-p', tasks: ['a'] },
        { id: 'c', heading: 'Plan launch / Food', list: 'page-c', tasks: ['c1'] },
        { id: 'l1', heading: 'Launch', list: 'l1', tasks: ['z'] },
      ],
    });
  });

  test('done judged by the list holding the task', () => {
    const custom = list(
      'l1',
      [
        parent('p', [task('a', { status: 'shipped' })], {
          subtasks: list('page-p', [task('a', { status: 'shipped' })], {
            statuses: [
              { id: 's1', slug: 'todo', name: 'Todo', color: 'x', group: 'todo', position: 0 },
              { id: 's2', slug: 'shipped', name: 'Shipped', color: 'x', group: 'done', position: 1 },
            ],
          }),
        }),
        task('z', { status: 'shipped' }),
      ],
      { title: 'Launch' },
    );
    assert({
      given: 'a slug that is done in the sub-list but unknown to the root list',
      should: 'drop the sub-list’s leaf and keep the root’s',
      actual: shape(custom).map((group) => group.tasks),
      expected: [['z']],
    });
  });

  test('a parent whose subtasks are not loaded', () => {
    assert({
      given: 'a task the server counts subtasks for that the tree has not loaded',
      should: 'not treat it as a leaf',
      actual: shape(list('l1', [task('p', { subTaskCount: 2 })])),
      expected: [],
    });
  });

  test('soonest first', () => {
    const dated = list(
      'l1',
      [
        parent('p', [task('a')], { title: 'Later', dueDate: '2026-10-20' }),
        parent('q', [task('b', { dueDate: '2026-10-07' })], { title: 'Sooner' }),
        parent('r', [task('c')], { title: 'Undated' }),
      ],
      { title: 'Launch' },
    );
    assert({
      given: 'groups with a parent due date, a leaf due date and none',
      should: 'order them by the earliest date each carries, undated last in tree order',
      actual: shape(dated).map((group) => group.id),
      expected: ['q', 'p', 'r'],
    });
  });

  test('nothing open', () => {
    assert({
      given: 'an empty list',
      should: 'have no groups',
      actual: frontier(list('l1', [])),
      expected: [],
    });
  });
});

describe('doneToday()', () => {
  test('completed today at any depth', () => {
    assert({
      given: 'a done leaf completed today, one completed yesterday and an open one',
      should: 'keep only today’s, with the list holding it',
      actual: doneToday(launch(), at(5, 18)).map(({ task: done, list: holder }) => [done.id, holder.pageId]),
      expected: [['b', 'page-p']],
    });
  });

  test('a completedAt left on a reopened task', () => {
    const reopened = list('l1', [task('x', { status: 'pending', completedAt: stamp(5) })]);
    assert({
      given: 'an open task that still carries today’s completedAt',
      should: 'not count it as done',
      actual: doneToday(reopened, at(5)),
      expected: [],
    });
  });

  test('the injected clock decides the day', () => {
    assert({
      given: 'the same tree read on the next day',
      should: 'count nothing from the day before',
      actual: doneToday(launch(), at(6, 0)),
      expected: [],
    });
  });
});

describe('sameLocalDay()', () => {
  test('local calendar days', () => {
    assert({
      given: 'a stamp just before and just after local midnight',
      should: 'judge them by the local day, not the UTC one',
      actual: [
        sameLocalDay(new Date(2026, 9, 5, 23, 59).toISOString(), at(5, 0)),
        sameLocalDay(new Date(2026, 9, 6, 0, 1).toISOString(), at(5, 23)),
      ],
      expected: [true, false],
    });
  });
});
