import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { list, seededStatuses, task } from '../task-model/fixtures';
import type { TaskStatus } from '../task-model/task';
import {
  boardColumns,
  columnJump,
  dropStatus,
  moveAnnouncement,
  moveTargets,
  wipOf,
  type ColumnRect,
} from './board';

const slugs = (columns: ReturnType<typeof boardColumns>) =>
  columns.map((column) => [column.status.slug, column.tasks.map((entry) => entry.id)]);

describe('boardColumns()', () => {
  test('one column per status', () => {
    const shuffled = [seededStatuses[2], seededStatuses[0], seededStatuses[3], seededStatuses[1]] as TaskStatus[];
    const board = list('l1', [
      task('a', { status: 'in_progress' }),
      task('b', { status: 'pending' }),
      task('c', { status: 'completed' }),
      task('d', { status: 'in_progress' }),
    ], { statuses: shuffled });
    assert({
      given: 'a list’s four statuses in any order and its top-level tasks',
      should: 'give a column per status in position order, each holding its tasks in list order',
      actual: slugs(boardColumns(board)),
      expected: [
        ['pending', ['b']],
        ['in_progress', ['a', 'd']],
        ['blocked', []],
        ['completed', ['c']],
      ],
    });
  });

  test('a status the list no longer defines', () => {
    const board = list('l1', [task('a', { status: 'archived' }), task('b', { status: 'completed' })]);
    assert({
      given: 'a task whose slug is not one of the list’s statuses',
      should: 'show it in the first column, as classic’s board does',
      actual: slugs(boardColumns(board))[0],
      expected: ['pending', ['a']],
    });
  });

  test('a list with no statuses', () => {
    const board = list('l1', [task('a', { status: 'blocked' })], { statuses: [] });
    assert({
      given: 'a list that defines no statuses',
      should: 'give the four statuses the server accepts for it, in classic’s order and names',
      actual: boardColumns(board).map((column) => [column.status.slug, column.status.name, column.tasks.length]),
      expected: [
        ['pending', 'To Do', 0],
        ['in_progress', 'In Progress', 0],
        ['blocked', 'Blocked', 1],
        ['completed', 'Done', 0],
      ],
    });
  });
});

describe('wipOf()', () => {
  const doing: TaskStatus = { ...(seededStatuses[1] as TaskStatus), wipLimit: 2 };

  test('a status with a limit', () => {
    assert({
      given: 'a column limited to two holding one, two and three tasks',
      should: 'count against the limit and flag only the column over it',
      actual: [1, 2, 3].map((count) => wipOf(doing, count)),
      expected: [
        { count: 1, limit: 2, over: false },
        { count: 2, limit: 2, over: false },
        { count: 3, limit: 2, over: true },
      ],
    });
  });

  test('a status without one', () => {
    assert({
      given: 'a status with no limit',
      should: 'have no WIP limit to show',
      actual: wipOf(seededStatuses[1] as TaskStatus, 5),
      expected: null,
    });
  });
});

describe('moveTargets()', () => {
  test('every other column', () => {
    const board = list('l1', [task('a', { status: 'in_progress' }), task('b', { status: 'archived' })]);
    const columns = boardColumns(board);
    assert({
      given: 'a task in In Progress, and one shown in the first column for an unknown slug',
      should: 'offer every column but the one it is shown in',
      actual: [moveTargets(columns, 'a').map((status) => status.slug), moveTargets(columns, 'b').map((s) => s.slug)],
      expected: [
        ['pending', 'blocked', 'completed'],
        ['in_progress', 'blocked', 'completed'],
      ],
    });
  });
});

describe('dropStatus()', () => {
  const columns = boardColumns(list('l1', [task('a', { status: 'pending' })]));

  test('a drop on another column', () => {
    assert({
      given: 'a card dropped on the Done column',
      should: 'move it to Done',
      actual: dropStatus(columns, 'a', 'completed'),
      expected: 'completed',
    });
  });

  test('drops that move nothing', () => {
    assert({
      given: 'a drop on its own column, outside every column, or of a card the board does not hold',
      should: 'move nothing',
      actual: [dropStatus(columns, 'a', 'pending'), dropStatus(columns, 'a', null), dropStatus(columns, 'x', 'completed')],
      expected: [null, null, null],
    });
  });
});

describe('columnJump()', () => {
  const rects: readonly ColumnRect[] = [
    { id: 'pending', left: 0, top: 100, width: 240, height: 400 },
    { id: 'in_progress', left: 252, top: 100, width: 240, height: 400 },
    { id: 'completed', left: 504, top: 100, width: 240, height: 400 },
  ];
  const card = { left: 10, top: 140, width: 200, height: 60 };

  test('arrows step a column', () => {
    assert({
      given: 'a card held over To Do, then over In Progress',
      should: 'centre it on the next column right, or back left',
      actual: [
        columnJump('ArrowRight', rects, 'pending', card),
        columnJump('ArrowLeft', rects, 'in_progress', { ...card, left: 272 }),
      ],
      expected: [
        { x: 272, y: 108 },
        { x: 20, y: 108 },
      ],
    });
  });

  test('edges and other keys', () => {
    assert({
      given: 'Left in the first column, Right in the last, and Down',
      should: 'stay put',
      actual: [
        columnJump('ArrowLeft', rects, 'pending', card),
        columnJump('ArrowRight', rects, 'completed', card),
        columnJump('ArrowDown', rects, 'pending', card),
      ],
      expected: [undefined, undefined, undefined],
    });
  });

  test('before the card is over a column', () => {
    assert({
      given: 'a card just picked up, over nothing yet',
      should: 'step from the column its centre is in',
      actual: columnJump('ArrowRight', rects, null, { ...card, left: 260 }),
      expected: { x: 524, y: 108 },
    });
  });
});

describe('moveAnnouncement()', () => {
  test('saved and refused', () => {
    assert({
      given: 'a move the server saved, and one refused',
      should: 'say where the task went, or why it did not',
      actual: [
        moveAnnouncement('Book venue', 'Done', { ok: true }),
        moveAnnouncement('Plan launch', 'Done', { ok: false, refusal: 'Complete all sub-tasks first (1 of 1 remaining)' }),
      ],
      expected: [
        'Moved Book venue to Done.',
        'Could not move Plan launch to Done: Complete all sub-tasks first (1 of 1 remaining)',
      ],
    });
  });
});
