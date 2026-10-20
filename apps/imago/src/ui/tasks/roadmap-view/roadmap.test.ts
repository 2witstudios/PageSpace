import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { dueDateFor } from '../task-detail/due-date';
import { settledPatch, updateTask } from '../task-edit/task-edit';
import { list, task } from '../task-model/fixtures';
import type { Task, TaskList } from '../task-model/task';
import {
  addDays,
  datesOf,
  dayDelta,
  daysBetween,
  dragLabel,
  dragModeOf,
  dragPatch,
  draggedDates,
  headerOf,
  keyDelta,
  markOf,
  overdueOf,
  progressOf,
  rangeOf,
  readZoom,
  roadmapRows,
  rowLabel,
  shortDate,
  spanOf,
  timelineWidth,
  todayScroll,
  unscheduledTasks,
  weekdayDate,
  writeZoom,
  xForDay,
  zoomKey,
  type Range,
  type ZoomStorage,
} from './roadmap';

/** An ISO instant at the viewer's local midnight of a day, as PATCH sends it. */
const at = (day: string): string => dueDateFor(day) ?? '';

const TODAY = '2026-10-19';

const dated = (id: string, start: string | null, due: string | null, overrides: Partial<Task> = {}): Task =>
  task(id, {
    title: `Task ${id}`,
    startDate: start === null ? null : at(start),
    dueDate: due === null ? null : at(due),
    createdAt: at('2026-10-01'),
    ...overrides,
  });

const withChildren = (parentTask: Task, children: readonly Task[]): Task => ({
  ...parentTask,
  subtasks: list(parentTask.pageId, children),
});

describe('calendar days', () => {
  test('adding and counting days', () => {
    assert({
      given: 'days across a month end, a year end and a daylight-saving change',
      should: 'count whole calendar days',
      actual: [
        addDays('2026-10-30', 3),
        addDays('2026-12-31', 1),
        addDays('2026-10-19', -19),
        daysBetween('2026-10-24', '2026-11-02'),
        daysBetween('2026-03-07', '2026-03-09'),
      ],
      expected: ['2026-11-02', '2027-01-01', '2026-09-30', 9, 2],
    });
  });

  test('labels', () => {
    assert({
      given: 'a day',
      should: 'read as a short date and as weekday and date',
      actual: [shortDate('2026-10-12'), weekdayDate('2026-10-27'), weekdayDate('2026-10-24')],
      expected: ['Oct 12', 'Tue 27', 'Sat 24'],
    });
  });
});

describe('marks', () => {
  test('bars, milestones and nothing', () => {
    assert({
      given: 'top-level and subtasks with and without start and due dates',
      should:
        'draw a bar from the start (or the creation day) for a dated top-level task, a milestone for a subtask with no start, and nothing without a due date',
      actual: [
        markOf(dated('a', '2026-10-12', '2026-10-23'), 0),
        markOf(dated('b', null, '2026-10-23'), 0),
        markOf(dated('c', null, '2026-10-23'), 1),
        markOf(dated('d', '2026-10-20', '2026-10-23'), 1),
        markOf(dated('e', '2026-10-12', null), 0),
      ],
      expected: [
        { kind: 'bar', start: '2026-10-12', due: '2026-10-23' },
        { kind: 'bar', start: '2026-10-01', due: '2026-10-23' },
        { kind: 'milestone', due: '2026-10-23' },
        { kind: 'bar', start: '2026-10-20', due: '2026-10-23' },
        { kind: 'none' },
      ],
    });
  });

  test('a creation day after the due date', () => {
    assert({
      given: 'a task made after the day it was due',
      should: 'start its bar on the due day',
      actual: markOf(dated('a', null, '2026-09-20'), 0),
      expected: { kind: 'bar', start: '2026-09-20', due: '2026-09-20' },
    });
  });

  test('progress', () => {
    assert({
      given: 'a done task, a task with half its subtasks done, and a leaf',
      should: 'fill whole, half, and not at all',
      actual: [
        progressOf(task('a', { subTaskCount: 4, subTaskCompletedCount: 1 }), true),
        progressOf(task('b', { subTaskCount: 4, subTaskCompletedCount: 2 }), false),
        progressOf(task('c'), false),
      ],
      expected: [1, 0.5, 0],
    });
  });

  test('overdue span', () => {
    assert({
      given: 'an open task due three days ago, one due today, and a done one due earlier',
      should: 'span the days after the due date through today only for the open late one',
      actual: [
        overdueOf('2026-10-16', TODAY, false),
        overdueOf(TODAY, TODAY, false),
        overdueOf('2026-10-16', TODAY, true),
      ],
      expected: [{ from: '2026-10-17', to: TODAY }, null, null],
    });
  });
});

describe('rows', () => {
  const launch: TaskList = list('l1', [
    withChildren(dated('p', '2026-10-12', '2026-10-23', { status: 'in_progress', title: 'Prepare launch email' }), [
      dated('p1', null, '2026-10-15'),
      dated('p2', null, null),
    ]),
    dated('q', null, null),
    withChildren(dated('r', null, null), [dated('r1', '2026-10-20', '2026-10-28', { status: 'completed' })]),
    dated('s', null, '2026-10-16'),
  ]);

  test('which tasks get rows', () => {
    assert({
      given: 'a list with dated, undated and undated-but-parent tasks',
      should: 'give rows in list order to dated tasks and to undated parents of dated subtasks, a level in for subtasks',
      actual: roadmapRows(launch, TODAY).map((row) => [row.task.id, row.depth, row.mark.kind]),
      expected: [
        ['p', 0, 'bar'],
        ['p1', 1, 'milestone'],
        ['r', 0, 'none'],
        ['r1', 1, 'bar'],
        ['s', 0, 'bar'],
      ],
    });
  });

  test('tints and lateness', () => {
    const rows = roadmapRows(launch, TODAY);
    assert({
      given: 'rows in progress, to do and done',
      should: 'carry the status group of their own list and mark open late ones overdue',
      actual: rows.map((row) => [row.task.id, row.group, row.done, row.overdue !== null]),
      expected: [
        ['p', 'in_progress', false, false],
        ['p1', 'todo', false, true],
        ['r', 'todo', false, false],
        ['r1', 'done', true, false],
        ['s', 'todo', false, true],
      ],
    });
  });

  test('unscheduled', () => {
    assert({
      given: 'the same list',
      should: 'tray every loaded task with no due date, at any level',
      actual: unscheduledTasks(launch).map((entry) => entry.id),
      expected: ['p2', 'q', 'r'],
    });
  });

  test('accessible names', () => {
    const [bar, milestone] = roadmapRows(launch, TODAY);
    assert({
      given: 'a bar and a late milestone',
      should: 'name the task, its dates and status, and say it is overdue',
      actual: [bar === undefined ? '' : rowLabel(bar), milestone === undefined ? '' : rowLabel(milestone)],
      expected: ['Prepare launch email, Oct 12 to Oct 23, In Progress', 'Task p1, due Oct 15, To Do, overdue'],
    });
  });
});

describe('range and geometry', () => {
  test('range', () => {
    const rows = roadmapRows(list('l', [dated('a', '2026-10-12', '2026-11-05')]), TODAY);
    assert({
      given: 'a bar from Oct 12 to Nov 5, and no rows at all',
      should: 'run a week before the first start to three weeks after the last due date, always holding today',
      actual: [rangeOf(rows, TODAY), rangeOf([], TODAY)],
      expected: [
        { start: '2026-10-05', end: '2026-11-26', days: 53 },
        { start: '2026-10-12', end: '2026-11-09', days: 29 },
      ],
    });
  });

  test('range far in the past', () => {
    const rows = roadmapRows(list('l', [dated('a', '2026-01-10', '2026-02-01')]), TODAY);
    assert({
      given: 'work that ended months ago',
      should: 'still reach three weeks past today',
      actual: rangeOf(rows, TODAY).end,
      expected: '2026-11-09',
    });
  });

  const range: Range = { start: '2026-10-05', end: '2026-11-26', days: 53 };

  test('x for a day', () => {
    assert({
      given: 'days on a range at 36px a day',
      should: 'sit their left edge whole days from the first',
      actual: [
        xForDay(range, '2026-10-05', 36),
        xForDay(range, '2026-10-12', 36),
        xForDay(range, '2026-10-12', 4),
        timelineWidth(range, 12),
        spanOf(range, '2026-10-12', '2026-10-23', 36),
      ],
      expected: [0, 252, 28, 636, { left: 252, width: 432 }],
    });
  });

  test('today a quarter in', () => {
    assert({
      given: 'a viewport 800px wide, and today near the start',
      should: 'scroll so today sits a quarter of the way in, never before the start',
      actual: [todayScroll(range, TODAY, 36, 800), todayScroll(range, '2026-10-05', 36, 800)],
      expected: [14 * 36 + 18 - 200, 0],
    });
  });
});

describe('the header', () => {
  const range: Range = { start: '2026-10-12', end: '2026-11-08', days: 28 };

  test('weeks', () => {
    const header = headerOf(range, 'weeks');
    assert({
      given: 'four weeks from Mon Oct 12 at the Weeks zoom',
      should: 'label every day, shade weekends, and name the months',
      actual: {
        ticks: header.ticks.length,
        first: header.ticks[0],
        saturday: header.ticks[5],
        weekends: header.weekends.slice(0, 2),
        months: header.months,
      },
      expected: {
        ticks: 28,
        first: { day: '2026-10-12', x: 0, label: '12', weekend: false },
        saturday: { day: '2026-10-17', x: 180, label: '17', weekend: true },
        weekends: [
          { left: 180, width: 36 },
          { left: 216, width: 36 },
        ],
        months: [
          { day: '2026-10-12', x: 0, label: 'Oct 2026' },
          { day: '2026-11-01', x: 720, label: 'Nov 2026' },
        ],
      },
    });
  });

  test('months and quarter', () => {
    const months = headerOf(range, 'months');
    const quarter = headerOf(range, 'quarter');
    assert({
      given: 'the same range at the Months and Quarter zooms',
      should: 'tick Mondays, label them only in Months, and shade nothing',
      actual: [
        months.ticks.map((tick) => [tick.day, tick.x, tick.label]),
        quarter.ticks.map((tick) => tick.label),
        months.weekends.length + quarter.weekends.length,
      ],
      expected: [
        [
          ['2026-10-12', 0, '12'],
          ['2026-10-19', 84, '19'],
          ['2026-10-26', 168, '26'],
          ['2026-11-02', 252, '2'],
        ],
        ['', '', '', ''],
        0,
      ],
    });
  });

  test('a short lead month', () => {
    assert({
      given: 'a range starting four days before a month begins',
      should: 'name only the month that begins, so labels never collide',
      actual: headerOf({ start: '2026-10-28', end: '2026-11-10', days: 14 }, 'weeks').months.map((m) => m.label),
      expected: ['Nov 2026'],
    });
  });
});

describe('dragging', () => {
  const span = { start: '2026-10-12', due: '2026-10-23' };

  test('pixels to days', () => {
    assert({
      given: 'pointer travel at 36px a day',
      should: 'round to whole days',
      actual: [dayDelta(100, 36), dayDelta(-17, 36), dayDelta(-19, 36), dayDelta(5, 36)],
      expected: [3, 0, -1, 0],
    });
  });

  test('moving edges and bodies', () => {
    assert({
      given: 'a due edge, a start edge and the body moved',
      should: 'move that date, clamping so the start never passes the due date',
      actual: [
        draggedDates(span, 'due', 3),
        draggedDates(span, 'due', -20),
        draggedDates(span, 'start', 2),
        draggedDates(span, 'start', 30),
        draggedDates(span, 'move', -5),
      ],
      expected: [
        { start: '2026-10-12', due: '2026-10-26' },
        { start: '2026-10-12', due: '2026-10-12' },
        { start: '2026-10-14', due: '2026-10-23' },
        { start: '2026-10-23', due: '2026-10-23' },
        { start: '2026-10-07', due: '2026-10-18' },
      ],
    });
  });

  test('an unpinned start', () => {
    assert({
      given: 'a bar that starts only where it was made, its due date dragged before that',
      should: 'let the due date go, and the start follow it',
      actual: draggedDates(span, 'due', -20, false),
      expected: { start: '2026-10-03', due: '2026-10-03' },
    });
  });

  test('milestones only move', () => {
    const milestone = { kind: 'milestone', due: '2026-10-15' } as const;
    assert({
      given: 'a milestone held by its edge, and a bar held by its edge',
      should: 'move the milestone whole and keep the bar edge',
      actual: [dragModeOf(milestone, 'due'), dragModeOf({ kind: 'bar', ...span }, 'due'), datesOf(milestone)],
      expected: ['move', 'due', { start: '2026-10-15', due: '2026-10-15' }],
    });
  });

  test('what is saved', () => {
    const bar = { kind: 'bar', ...span } as const;
    const milestone = { kind: 'milestone', due: '2026-10-23' } as const;
    const later = draggedDates(span, 'move', 3);
    assert({
      given: 'drags of each kind, and one that changed nothing',
      should: 'patch the dragged date, both for a moved bar, only the due date for a milestone, nothing when unchanged',
      actual: [
        dragPatch(bar, span, draggedDates(span, 'due', 3), 'due'),
        dragPatch(bar, span, draggedDates(span, 'start', -1), 'start'),
        dragPatch(bar, span, later, 'move'),
        dragPatch(milestone, { start: '2026-10-23', due: '2026-10-23' }, { start: '2026-10-25', due: '2026-10-25' }, 'move'),
        dragPatch(bar, span, span, 'move'),
      ],
      expected: [
        { dueDate: at('2026-10-26') },
        { startDate: at('2026-10-11') },
        { startDate: at('2026-10-15'), dueDate: at('2026-10-26') },
        { dueDate: at('2026-10-25') },
        null,
      ],
    });
  });

  test('a due edge dragged onto a start with a time of day', () => {
    // A start set over the API at 09:00 local on the 12th; the bar's due edge goes back to that day.
    const startDate = new Date(2026, 9, 12, 9).toISOString();
    const root = list('root', [task('a', { startDate, dueDate: at('2026-10-23') })]);
    const bar = { kind: 'bar', ...span } as const;
    const patch = dragPatch(bar, span, draggedDates(span, 'due', -20), 'due') ?? {};
    const saved = updateTask(root, 'a', patch);
    assert({
      given: 'the due edge clamped onto the start’s own day, sent as that day’s midnight',
      should: 'save the due date at the start’s instant rather than refuse it',
      actual: [settledPatch(root.tasks[0], patch), saved.refusal, saved.list.tasks[0]?.dueDate],
      expected: [{ dueDate: startDate }, undefined, startDate],
    });
  });

  test('the tooltip', () => {
    assert({
      given: 'a due date dragged three days on, and a start dragged two back',
      should: 'say the new day, the old day and the change',
      actual: [
        dragLabel({ start: '2026-10-12', due: '2026-10-24' }, { start: '2026-10-12', due: '2026-10-27' }, 'due'),
        dragLabel({ start: '2026-10-12', due: '2026-10-24' }, { start: '2026-10-10', due: '2026-10-24' }, 'start'),
      ],
      expected: ['Due Tue 27 · was Sat 24 · +3d', 'Start Sat 10 · was Mon 12 · -2d'],
    });
  });

  test('keys', () => {
    assert({
      given: 'arrow keys with and without Shift, and another key',
      should: 'move a day, a week, or not at all',
      actual: [keyDelta('ArrowRight', false), keyDelta('ArrowLeft', false), keyDelta('ArrowRight', true), keyDelta('ArrowLeft', true), keyDelta('Enter', false)],
      expected: [1, -1, 7, -7, 0],
    });
  });
});

describe('the saved zoom', () => {
  const memory = (): ZoomStorage & { readonly data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
  };
  const refusing: ZoomStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };

  test('reading and writing', () => {
    const storage = memory();
    writeZoom(storage, 'l1', 'quarter');
    storage.data.set(zoomKey('l2'), 'decades');
    assert({
      given: 'a saved zoom, a nonsense one, none, and a storage that refuses',
      should: 'read back only a real zoom, keyed by the list, and never throw',
      actual: [
        zoomKey('l1'),
        readZoom(storage, 'l1'),
        readZoom(storage, 'l2'),
        readZoom(storage, 'l3'),
        readZoom(null, 'l1'),
        readZoom(refusing, 'l1'),
        (() => {
          writeZoom(refusing, 'l1', 'weeks');
          return 'kept';
        })(),
      ],
      expected: ['imago:roadmap-zoom:l1', 'quarter', null, null, null, null, 'kept'],
    });
  });
});
