import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { list, seededStatuses, task } from '../task-model/fixtures';
import type { Task, TaskStatus } from '../task-model/task';
import {
  laneAssignees,
  boardColumns,
  boardLanes,
  boardRows,
  cellId,
  collapsedKey,
  columnJump,
  dropIndex,
  dropPlace,
  dropStatus,
  laneKeyOf,
  lanesKey,
  moveAnnouncement,
  moveTargets,
  parseWipLimit,
  planDrop,
  readCollapsed,
  readLaneMode,
  toggledCollapsed,
  wipTone,
  writeCollapsed,
  writeLaneMode,
  type BoardCell,
  type ColumnRect,
  type LaneMode,
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

describe('moveTargets()', () => {
  test('every other column', () => {
    const board = list('l1', [task('a', { status: 'in_progress' }), task('b', { status: 'archived' })]);
    const columns = boardColumns(board);
    assert({
      given: 'a task in In Progress, and one shown in the first column for an unknown slug',
      should: 'offer every status but the one it is in, so the unknown one can still move to the first',
      actual: [moveTargets(columns, 'a').map((status) => status.slug), moveTargets(columns, 'b').map((s) => s.slug)],
      expected: [
        ['pending', 'blocked', 'completed'],
        ['pending', 'in_progress', 'blocked', 'completed'],
      ],
    });
  });
});

describe('dropStatus()', () => {
  const columns = boardColumns(list('l1', [task('a', { status: 'pending' }), task('b', { status: 'archived' })]));

  test('a drop on another column', () => {
    assert({
      given: 'a card dropped on the Done column',
      should: 'move it to Done',
      actual: dropStatus(columns, 'a', 'completed'),
      expected: 'completed',
    });
  });

  test('a drop of an unknown slug on the column it is shown in', () => {
    assert({
      given: 'a card shown in To Do for an unknown slug, dropped on To Do',
      should: 'move it to To Do for real',
      actual: dropStatus(columns, 'b', 'pending'),
      expected: 'pending',
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

// a, b to do; c in progress; d to do — one order across the columns.
const ordered = list('l1', [
  task('a', { status: 'pending', priority: 'high' }),
  task('b', { status: 'pending' }),
  task('c', { status: 'in_progress', assignees: [{ type: 'user', id: 'u-2', name: 'Ada' }] }),
  task('d', { status: 'pending', assignees: [{ type: 'agent', id: 'ag-1', name: 'Imago' }, { type: 'user', id: 'u-2', name: 'Ada' }] }),
]);

const taskAt = (index: number) => ordered.tasks[index] as Task;

const cellsOf = (mode: LaneMode) => {
  const columns = boardColumns(ordered);
  return new Map(boardRows(columns, boardLanes(ordered, mode), mode).flatMap((row) => row.cells.map((cell) => [cell.id, cell])));
};

const cell = (mode: LaneMode, id: string) => cellsOf(mode).get(id) as BoardCell;

describe('lanes', () => {
  test('the lanes of each mode', () => {
    assert({
      given: 'a board with no lanes, by priority and by assignee',
      should: 'give one lane; all three priorities; each first assignee in list order, then Unassigned',
      actual: (['none', 'priority', 'assignee'] as const).map((mode) => boardLanes(ordered, mode).map((lane) => lane.label)),
      expected: [['All tasks'], ['High priority', 'Medium priority', 'Low priority'], ['Ada', 'Imago', 'Unassigned']],
    });
  });

  test('which lane a card is in', () => {
    assert({
      given: 'a task on two people, and one on no one',
      should: 'put the first in its first assignee’s lane and the other in Unassigned',
      actual: [laneKeyOf(taskAt(3), 'assignee'), laneKeyOf(taskAt(0), 'assignee'), laneKeyOf(taskAt(0), 'priority')],
      expected: ['assignee:agent:ag-1', 'assignee:none', 'priority:high'],
    });
  });

  test('cells', () => {
    assert({
      given: 'the board split by priority',
      should: 'give each lane a cell per column with an id of its own, the cards in list order',
      actual: [cell('priority', cellId('priority:medium', 'pending')).tasks.map((entry) => entry.id), cell('priority', 'priority:high::pending').tasks.map((entry) => entry.id)],
      expected: [['b', 'd'], ['a']],
    });
  });
});

describe('dropPlace()', () => {
  const todo = cell('none', 'all::pending');
  test('within a cell and from another', () => {
    assert({
      given: 'a card carried down onto a later one, up onto an earlier one, and one from another cell held in the lower and upper half',
      should: 'land after, before, then by the half it is held over',
      actual: [dropPlace(todo, 'a', 'd', false), dropPlace(todo, 'd', 'a', true), dropPlace(todo, 'c', 'b', true), dropPlace(todo, 'c', 'b', false)],
      expected: ['after', 'before', 'after', 'before'],
    });
  });
});

describe('dropIndex()', () => {
  const todo = cell('none', 'all::pending');
  const done = cell('none', 'all::completed');
  test('on a card, on open space and into an empty cell', () => {
    assert({
      given: 'c dropped before b, after d, on To Do’s open space, and into the empty Done',
      should: 'count its place among the others: next to the card, after the cell’s last, or where it is',
      actual: [
        dropIndex(ordered.tasks, 'c', todo, { kind: 'card', overId: 'b', place: 'before' }),
        dropIndex(ordered.tasks, 'c', todo, { kind: 'card', overId: 'd', place: 'after' }),
        dropIndex(ordered.tasks, 'c', todo, { kind: 'cell' }),
        dropIndex(ordered.tasks, 'c', done, { kind: 'cell' }),
        dropIndex(ordered.tasks, 'a', todo, { kind: 'card', overId: 'a', place: 'after' }),
      ],
      expected: [1, 3, 3, 2, 0],
    });
  });
});

describe('planDrop()', () => {
  const columns = boardColumns(ordered);
  test('status, order and lane', () => {
    assert({
      given: 'a dropped after d in To Do, c dropped in Done, a dropped on itself, and b dropped in the High lane',
      should: 'reorder only; change status only; do nothing; and give b high priority, in its place',
      actual: [
        planDrop(ordered, columns, 'a', cell('none', 'all::pending'), { kind: 'card', overId: 'd', place: 'after' }, 'none'),
        planDrop(ordered, columns, 'c', cell('none', 'all::completed'), { kind: 'cell' }, 'none'),
        planDrop(ordered, columns, 'a', cell('none', 'all::pending'), { kind: 'card', overId: 'a', place: 'before' }, 'none'),
        planDrop(ordered, columns, 'b', cell('priority', 'priority:high::pending'), { kind: 'card', overId: 'a', place: 'after' }, 'priority'),
      ].map((plan) => (plan === null ? null : [plan.status.slug, plan.statusChanged, plan.index, plan.change])),
      expected: [
        ['pending', false, 3, null],
        ['completed', true, null, null],
        null,
        ['pending', false, null, { field: 'priority', priority: 'high' }],
      ],
    });
  });

  test('a filtered board', () => {
    assert({
      given: 'a board that may not reorder: a dropped after d, and c dropped before a in To Do',
      should: 'do nothing for the first and change only the status for the second',
      actual: [
        planDrop(ordered, columns, 'a', cell('none', 'all::pending'), { kind: 'card', overId: 'd', place: 'after' }, 'none', false),
        planDrop(ordered, columns, 'c', cell('none', 'all::pending'), { kind: 'card', overId: 'a', place: 'before' }, 'none', false),
      ].map((plan) => (plan === null ? null : [plan.status.slug, plan.statusChanged, plan.index])),
      expected: [null, ['pending', true, null]],
    });
  });
});

describe('wipTone() and parseWipLimit()', () => {
  test('limits', () => {
    assert({
      given: 'no limit, under, at and over a limit of 3; then a blank, a number and junk typed',
      should: 'grade the count, and read blank as clearing',
      actual: [[wipTone(2, null), wipTone(2, 3), wipTone(3, 3), wipTone(4, 3)], [parseWipLimit(' '), parseWipLimit(' 4 '), Number.isNaN(parseWipLimit('x'))]],
      expected: [[null, 'under', 'at', 'over'], [null, 4, true]],
    });
  });
});

describe('the viewer’s board choices', () => {
  const memory = () => {
    const store = new Map<string, string>();
    return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  };
  const refusing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };

  test('kept per list', () => {
    const storage = memory();
    writeCollapsed(storage, 'l1', ['completed']);
    writeLaneMode(storage, 'l1', 'assignee');
    assert({
      given: 'Done folded and Assignee lanes chosen on l1',
      should: 'read them back for l1 under its own keys, and nothing for l2',
      actual: [readCollapsed(storage, 'l1'), readLaneMode(storage, 'l1'), readCollapsed(storage, 'l2'), readLaneMode(storage, 'l2'), collapsedKey('l1'), lanesKey('l1')],
      expected: [['completed'], 'assignee', [], 'none', 'imago:board-collapsed:l1', 'imago:board-lanes:l1'],
    });
  });

  test('storage that refuses, or holds junk', () => {
    const junk = memory();
    junk.setItem(collapsedKey('l1'), '{not json');
    junk.setItem(lanesKey('l1'), 'diagonal');
    writeCollapsed(refusing, 'l1', ['completed']);
    assert({
      given: 'storage that throws, and storage holding what the board never wrote',
      should: 'fall back to nothing folded and no lanes, without throwing',
      actual: [readCollapsed(refusing, 'l1'), readLaneMode(refusing, 'l1'), readCollapsed(junk, 'l1'), readLaneMode(junk, 'l1')],
      expected: [[], 'none', [], 'none'],
    });
  });

  test('folding and opening', () => {
    assert({
      given: 'Done folded, then folded again',
      should: 'add it, then take it off',
      actual: [toggledCollapsed([], 'completed'), toggledCollapsed(['completed'], 'completed')],
      expected: [['completed'], []],
    });
  });
});

describe('laneAssignees', () => {
  const alice = { type: 'user' as const, id: 'u-a', name: 'Alice' };
  const bob = { type: 'user' as const, id: 'u-b', name: 'Bob' };
  const carol = { type: 'user' as const, id: 'u-c', name: 'Carol' };
  test('swaps only the lane person', () => {
    const shared = task('t', { assignees: [alice, bob] });
    assert({
      given: "a task on Alice and Bob in Alice's lane, dropped into Carol's, Bob's, then Unassigned",
      should: 'swap Alice for the lane person and keep everyone else, or take everyone off',
      actual: [laneAssignees(shared, [carol]), laneAssignees(shared, [bob]), laneAssignees(shared, [])],
      expected: [[carol, bob], [bob], []],
    });
  });
});
