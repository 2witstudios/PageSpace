import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  addTask,
  moveTask,
  removeTask,
  setAssignees,
  setStatus,
  toggleAssignee,
  toggleComplete,
  updateTask,
} from './task-edit';
import { locate } from '../task-tree/task-tree';
import { list, parent, task } from '../task-model/fixtures';
import type { Task, TaskList } from '../task-model/task';

const NOW = '2026-10-05T09:00:00.000Z';
const EARLIER = '2026-10-01T00:00:00.000Z';
const done = { status: 'completed', completedAt: EARLIER };

const find = (root: TaskList, id: string): Task | undefined => locate(root, id)?.path.at(-1);

describe('setStatus()', () => {
  test('completing a leaf', () => {
    const root = list('root', [parent('p', [task('a'), task('b', done)])]);
    const outcome = setStatus(root, 'a', 'completed', NOW);

    assert({
      given: 'a leaf moved to a done status',
      should: 'take the status and stamp completedAt, as the server does',
      actual: [find(outcome.list, 'a')?.status, find(outcome.list, 'a')?.completedAt, outcome.refusal],
      expected: ['completed', NOW, undefined],
    });

    assert({
      given: 'a subtask completed',
      should: 'count it complete on its parent, as the server’s counts will',
      actual: [find(outcome.list, 'p')?.subTaskCompletedCount, find(outcome.list, 'p')?.subTaskCount],
      expected: [2, 2],
    });
  });

  test('reopening', () => {
    const root = list('root', [parent('p', [task('a', done)])]);
    const outcome = setStatus(root, 'a', 'in_progress', NOW);

    assert({
      given: 'a done subtask moved to an open status',
      should: 'clear completedAt and uncount it on its parent',
      actual: [find(outcome.list, 'a')?.completedAt, find(outcome.list, 'p')?.subTaskCompletedCount],
      expected: [null, 0],
    });
  });

  test('done to done', () => {
    const statuses = [...list('x', []).statuses, { id: 'cfg-shipped', slug: 'shipped', name: 'Shipped', color: '', group: 'done' as const, position: 4 }];
    const root = list('root', [parent('p', [task('a', done)], { subtasks: list('page-p', [task('a', done)], { statuses }) })]);
    const outcome = setStatus(root, 'a', 'shipped', NOW);

    assert({
      given: 'a done subtask moved to another done status',
      should: 're-stamp it as the server does without counting it twice',
      actual: [find(outcome.list, 'a')?.completedAt, find(outcome.list, 'p')?.subTaskCompletedCount],
      expected: [NOW, 1],
    });
  });

  test('a parent with open subtasks', () => {
    const root = list('root', [parent('p', [task('a'), task('b', done), task('c')])]);
    const outcome = setStatus(root, 'p', 'completed', NOW);

    assert({
      given: 'a parent with 2 of 3 subtasks open, moved to done',
      should: 'refuse in the server’s words',
      actual: outcome.refusal,
      expected: 'Complete all sub-tasks first (2 of 3 remaining)',
    });

    assert({
      given: 'a refused completion',
      should: 'leave the list exactly as it was',
      actual: outcome.list === root,
      expected: true,
    });
  });

  test('a parent whose subtasks are not loaded', () => {
    const root = list('root', [task('p', { subTaskCount: 2, subTaskCompletedCount: 1 })]);

    assert({
      given: 'a collapsed parent the server counts 1 of 2 open',
      should: 'refuse from the server’s counts alone',
      actual: setStatus(root, 'p', 'completed', NOW).refusal,
      expected: 'Complete all sub-tasks first (1 of 2 remaining)',
    });
  });

  test('statuses of the holding list', () => {
    const sub = list('page-p', [task('a', { status: 'icebox' })], {
      statuses: [
        { id: '1', slug: 'icebox', name: 'Icebox', color: '', group: 'todo', position: 0 },
        { id: '2', slug: 'shipped', name: 'Shipped', color: '', group: 'done', position: 1 },
      ],
    });
    const root = list('root', [parent('p', [], { subtasks: sub, subTaskCount: 1 })]);

    assert({
      given: 'a subtask moved to a slug only its own list defines',
      should: 'validate against that list, not the root',
      actual: find(setStatus(root, 'a', 'shipped', NOW).list, 'a')?.status,
      expected: 'shipped',
    });

    assert({
      given: 'a subtask moved to a slug only the root defines',
      should: 'refuse in the server’s words',
      actual: setStatus(root, 'a', 'completed', NOW).refusal,
      expected: 'Invalid status "completed". Valid statuses: icebox, shipped',
    });
  });

  test('a list with no statuses', () => {
    const root = list('root', [task('a')], { statuses: [] });

    assert({
      given: 'a list with no statuses and one of the four built-in slugs',
      should: 'accept it, completing on "completed"',
      actual: find(setStatus(root, 'a', 'completed', NOW).list, 'a')?.completedAt,
      expected: NOW,
    });

    assert({
      given: 'a list with no statuses and any other slug',
      should: 'refuse as the server does',
      actual: setStatus(root, 'a', 'shipped', NOW).refusal,
      expected: 'Invalid status',
    });
  });

  test('a missing task', () => {
    const root = list('root', [task('a')]);

    assert({
      given: 'an id no list holds',
      should: 'refuse with the server’s 404 wording and change nothing',
      actual: setStatus(root, 'nope', 'completed', NOW),
      expected: { list: root, refusal: 'Task not found' },
    });
  });
});

describe('toggleComplete()', () => {
  test('ticking and unticking', () => {
    const root = list('root', [task('a'), task('b', done)]);

    assert({
      given: 'an open task ticked',
      should: 'move to the list’s first done status',
      actual: find(toggleComplete(root, 'a', NOW).list, 'a')?.status,
      expected: 'completed',
    });

    assert({
      given: 'a done task unticked',
      should: 'move to the list’s first to-do status',
      actual: find(toggleComplete(root, 'b', NOW).list, 'b')?.status,
      expected: 'pending',
    });
  });

  test('a blocked parent', () => {
    const root = list('root', [parent('p', [task('a')])]);

    assert({
      given: 'a parent with an open subtask ticked',
      should: 'refuse',
      actual: toggleComplete(root, 'p', NOW).refusal,
      expected: 'Complete all sub-tasks first (1 of 1 remaining)',
    });
  });

  test('a missing task', () => {
    const root = list('root', []);

    assert({
      given: 'an id no list holds',
      should: 'refuse and change nothing',
      actual: toggleComplete(root, 'nope', NOW),
      expected: { list: root, refusal: 'Task not found' },
    });
  });
});

describe('updateTask()', () => {
  test('fields', () => {
    const root = list('root', [parent('p', [task('a')])]);
    const outcome = updateTask(root, 'a', { title: '  Write it  ', priority: 'high', dueDate: '2026-10-09T00:00:00.000Z' });

    assert({
      given: 'a title, priority and due date for a subtask',
      should: 'set them, trimming the title as the server does',
      actual: [find(outcome.list, 'a')?.title, find(outcome.list, 'a')?.priority, find(outcome.list, 'a')?.dueDate],
      expected: ['Write it', 'high', '2026-10-09T00:00:00.000Z'],
    });
  });

  test('clearing a due date', () => {
    const root = list('root', [task('a', { dueDate: '2026-10-09T00:00:00.000Z' })]);

    assert({
      given: 'a null due date',
      should: 'clear it',
      actual: find(updateTask(root, 'a', { dueDate: null }).list, 'a')?.dueDate,
      expected: null,
    });
  });

  test('refusals', () => {
    const root = list('root', [task('a')]);

    assert({
      given: 'a blank title',
      should: 'refuse in the server’s words and change nothing',
      actual: updateTask(root, 'a', { title: '   ' }),
      expected: { list: root, refusal: 'Title cannot be empty' },
    });

    assert({
      given: 'a priority the server does not know',
      should: 'refuse in the server’s words',
      actual: updateTask(root, 'a', { priority: 'urgent' as 'high' }).refusal,
      expected: 'Invalid priority',
    });

    assert({
      given: 'an id no list holds',
      should: 'refuse',
      actual: updateTask(root, 'nope', { priority: 'low' }).refusal,
      expected: 'Task not found',
    });
  });
});

describe('setAssignees() and toggleAssignee()', () => {
  const ada = { type: 'user' as const, id: 'u-ada', name: 'Ada' };
  const planner = { type: 'agent' as const, id: 'ag-1', name: 'Planner' };

  test('replacing', () => {
    const root = list('root', [task('a', { assignees: [ada] })]);

    assert({
      given: 'a new set of assignees, with a duplicate',
      should: 'replace the old set, once each',
      actual: find(setAssignees(root, 'a', [planner, ada, planner]), 'a')?.assignees,
      expected: [planner, ada],
    });
  });

  test('toggling', () => {
    const root = list('root', [task('a', { assignees: [ada] })]);

    assert({
      given: 'an agent not on the task',
      should: 'add it after the people already there',
      actual: find(toggleAssignee(root, 'a', planner), 'a')?.assignees,
      expected: [ada, planner],
    });

    assert({
      given: 'a person already on the task',
      should: 'take them off',
      actual: find(toggleAssignee(root, 'a', ada), 'a')?.assignees,
      expected: [],
    });

    assert({
      given: 'an id no list holds',
      should: 'change nothing',
      actual: toggleAssignee(root, 'nope', ada) === root,
      expected: true,
    });
  });
});

describe('addTask()', () => {
  const draft = { id: 'new', pageId: 'page-new', title: '  Plan  ', now: NOW };

  test('at the root', () => {
    const root = list('root', [task('a', { position: 1 })]);
    const outcome = addTask(root, { ...draft, listPageId: 'root' });

    assert({
      given: 'a new task for the root list',
      should: 'append it in the server’s seed status, after the last position',
      actual: outcome.list.tasks.map((entry) => [entry.id, entry.title, entry.status, entry.position]),
      expected: [
        ['a', 'Task a', 'pending', 1],
        ['new', 'Plan', 'pending', 2],
      ],
    });
  });

  test('under a task', () => {
    const root = list('root', [parent('p', [task('a', done)])]);
    const outcome = addTask(root, { ...draft, listPageId: 'page-p', status: 'in_progress', priority: 'high' });

    assert({
      given: 'a new subtask with a status and priority',
      should: 'add it under its parent with them',
      actual: locate(outcome.list, 'new')?.path.map((entry) => [entry.id, entry.status, entry.priority]),
      expected: [
        ['p', 'pending', 'medium'],
        ['new', 'in_progress', 'high'],
      ],
    });

    assert({
      given: 'a new open subtask',
      should: 'count it, open, on its parent',
      actual: [find(outcome.list, 'p')?.subTaskCount, find(outcome.list, 'p')?.subTaskCompletedCount],
      expected: [2, 1],
    });
  });

  test('a done subtask', () => {
    const root = list('root', [parent('p', [])]);
    const outcome = addTask(root, { ...draft, listPageId: 'page-p', status: 'completed' });

    assert({
      given: 'a new subtask created in a done status',
      should: 'stamp it and count it complete, as the create route does',
      actual: [find(outcome.list, 'new')?.completedAt, find(outcome.list, 'p')?.subTaskCompletedCount],
      expected: [NOW, 1],
    });
  });

  test('under a collapsed task', () => {
    const root = list('root', [task('p')]);
    const outcome = addTask(root, { ...draft, listPageId: 'page-p' });

    assert({
      given: 'the first subtask of a task',
      should: 'open its list with the parent list’s statuses, as the server seeds it',
      actual: [find(outcome.list, 'p')?.subtasks?.statuses, find(outcome.list, 'p')?.subtasks?.tasks.map((entry) => entry.id)],
      expected: [root.statuses, ['new']],
    });
  });

  test('the nesting cap', () => {
    const root = list('root', [parent('a', [parent('b', [parent('c', [parent('d', [task('e')])])])])]);

    assert({
      given: 'a subtask under a level-4 task',
      should: 'add it at level 5',
      actual: locate(addTask(root, { ...draft, listPageId: 'page-d' }).list, 'new')?.path.length,
      expected: 5,
    });

    assert({
      given: 'a subtask under a level-5 task',
      should: 'refuse',
      actual: addTask(root, { ...draft, listPageId: 'page-e' }),
      expected: { list: root, refusal: 'Tasks nest 5 levels deep at most' },
    });
  });

  test('refusals', () => {
    const root = list('root', [task('a')]);

    assert({
      given: 'a blank title',
      should: 'refuse in the server’s words',
      actual: addTask(root, { ...draft, title: ' ', listPageId: 'root' }),
      expected: { list: root, refusal: 'Title is required' },
    });

    assert({
      given: 'a status the list does not define',
      should: 'refuse in the server’s words',
      actual: addTask(root, { ...draft, listPageId: 'root', status: 'shipped' }).refusal,
      expected: 'Invalid status "shipped". Valid statuses: pending, in_progress, blocked, completed',
    });

    assert({
      given: 'a list page no task here owns',
      should: 'refuse',
      actual: addTask(root, { ...draft, listPageId: 'elsewhere' }).refusal,
      expected: 'Task list not found',
    });
  });
});

describe('removeTask()', () => {
  test('a done subtask', () => {
    const root = list('root', [parent('p', [task('a', done), task('b')])]);
    const next = removeTask(root, 'a');

    assert({
      given: 'a done subtask deleted',
      should: 'drop it and uncount it on its parent',
      actual: [find(next, 'p')?.subtasks?.tasks.map((entry) => entry.id), find(next, 'p')?.subTaskCount, find(next, 'p')?.subTaskCompletedCount],
      expected: [['b'], 1, 0],
    });
  });

  test('a parent', () => {
    const root = list('root', [parent('p', [task('a')]), task('z')]);

    assert({
      given: 'a parent deleted',
      should: 'take its subtasks with it',
      actual: allIds(removeTask(root, 'p')),
      expected: ['z'],
    });

    assert({
      given: 'an id no list holds',
      should: 'change nothing',
      actual: removeTask(root, 'nope') === root,
      expected: true,
    });
  });
});

describe('moveTask()', () => {
  const root = list('root', [parent('p', [task('a'), task('b'), task('c')]), task('z')]);

  test('reordering subtasks', () => {
    const moved = moveTask(root, 'c', 0);

    assert({
      given: 'the last subtask moved to the top',
      should: 'reorder its list',
      actual: find(moved.list, 'p')?.subtasks?.tasks.map((entry) => entry.id),
      expected: ['c', 'a', 'b'],
    });

    assert({
      given: 'a reorder',
      should: 'give every task of that list its new position, for PATCH /tasks/reorder',
      actual: moved.order,
      expected: { listPageId: 'page-p', tasks: [{ id: 'c', position: 0 }, { id: 'a', position: 1 }, { id: 'b', position: 2 }] },
    });
  });

  test('clamping and no-ops', () => {
    assert({
      given: 'an index past the end',
      should: 'move to the end',
      actual: find(moveTask(root, 'a', 99).list, 'p')?.subtasks?.tasks.map((entry) => entry.id),
      expected: ['b', 'c', 'a'],
    });

    assert({
      given: 'a negative index',
      should: 'move to the top',
      actual: moveTask(root, 'z', -3).list.tasks.map((entry) => entry.id),
      expected: ['z', 'p'],
    });

    assert({
      given: 'an id no list holds',
      should: 'change nothing and reorder nothing',
      actual: moveTask(root, 'nope', 0),
      expected: { list: root, order: null },
    });
  });
});

const allIds = (root: TaskList): string[] =>
  root.tasks.flatMap((entry) => [entry.id, ...(entry.subtasks ? allIds(entry.subtasks) : [])]);
