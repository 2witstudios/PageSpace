import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../store/state';
import { tasksPlugin } from './tasks-plugin';

const { setTaskView, toggleTaskExpanded } = tasksPlugin.transactions;

describe('tasksPlugin', () => {
  test('the default view', () => {
    assert({
      given: 'a fresh UI state',
      should: 'show Tree with nothing expanded',
      actual: [createInitialState().resources.taskView, createInitialState().resources.expandedTasks],
      expected: ['tree', []],
    });
  });

  test('setTaskView', () => {
    const state = createInitialState();
    const board = setTaskView(state, 'board');
    assert({
      given: 'a view chosen, then the same view again',
      should: 'store it, and return the same snapshot when nothing changes',
      actual: [board.resources.taskView, setTaskView(board, 'board') === board, setTaskView(state, 'tree') === state],
      expected: ['board', true, true],
    });
  });

  test('toggleTaskExpanded', () => {
    const state = createInitialState();
    const opened = toggleTaskExpanded(toggleTaskExpanded(state, 't-1'), 't-2');
    const closed = toggleTaskExpanded(opened, 't-1');
    assert({
      given: 'two tasks opened, then the first closed',
      should: 'track each task by id, leaving the rest of the state alone',
      actual: [opened.resources.expandedTasks, closed.resources.expandedTasks, closed.resources.collapsedSections],
      expected: [['t-1', 't-2'], ['t-2'], []],
    });
  });
});

describe('tasksPlugin slice', () => {
  test('its own resources and transactions', () => {
    assert({
      given: 'the tasks slice',
      should: 'start on Tree with nothing expanded and own the view and expansion transactions',
      actual: [tasksPlugin.resources(), Object.keys(tasksPlugin.transactions).sort()],
      expected: [{ taskView: 'tree', expandedTasks: [] }, ['setTaskView', 'toggleTaskExpanded']],
    });
  });
});
