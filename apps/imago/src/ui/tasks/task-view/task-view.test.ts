import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { readTaskView, taskViewKey, taskViews, writeTaskView, type ViewStorage } from './task-view';

/** An in-memory Storage: the two calls the preference makes, recorded. */
const memory = (seed: Record<string, string> = {}) => {
  const items = new Map(Object.entries(seed));
  const storage: ViewStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
  return { storage, items };
};

/** A Storage the browser refuses: private mode, blocked site data. */
const refusing: ViewStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('taskViews', () => {
  test('the switch', () => {
    assert({
      given: 'the canvases’ view switch',
      should: 'offer Focus, Tree and Board in that order',
      actual: taskViews.map(({ value, label }) => [value, label]),
      expected: [
        ['focus', 'Focus'],
        ['tree', 'Tree'],
        ['board', 'Board'],
      ],
    });
  });
});

describe('taskViewKey()', () => {
  test('per viewer', () => {
    assert({
      given: 'two viewers on one browser',
      should: 'keep each one’s choice under its own key',
      actual: [taskViewKey('u-1'), taskViewKey('u-2')],
      expected: ['imago:task-view:u-1', 'imago:task-view:u-2'],
    });
  });
});

describe('readTaskView()', () => {
  test('a stored choice', () => {
    const { storage } = memory({ 'imago:task-view:u-1': 'board', 'imago:task-view:u-2': 'focus' });
    assert({
      given: 'choices stored for two viewers',
      should: 'read only this viewer’s',
      actual: [readTaskView(storage, 'u-1'), readTaskView(storage, 'u-2')],
      expected: ['board', 'focus'],
    });
  });

  test('nothing usable', () => {
    const { storage } = memory({ 'imago:task-view:u-1': 'kanban' });
    assert({
      given: 'no choice, a value that is not a view, a refusing storage or none at all',
      should: 'read nothing, so the default stands',
      actual: [
        readTaskView(storage, 'u-2'),
        readTaskView(storage, 'u-1'),
        readTaskView(refusing, 'u-1'),
        readTaskView(null, 'u-1'),
      ],
      expected: [null, null, null, null],
    });
  });
});

describe('writeTaskView()', () => {
  test('saving', () => {
    const { storage, items } = memory();
    writeTaskView(storage, 'u-1', 'board');
    assert({
      given: 'a viewer choosing Board',
      should: 'store it under their key, readable again',
      actual: [items.get('imago:task-view:u-1'), readTaskView(storage, 'u-1')],
      expected: ['board', 'board'],
    });
  });

  test('a storage that refuses', () => {
    let threw = false;
    try {
      writeTaskView(refusing, 'u-1', 'tree');
      writeTaskView(null, 'u-1', 'tree');
    } catch {
      threw = true;
    }
    assert({
      given: 'a storage that throws, or none',
      should: 'keep the choice for this session only and never throw',
      actual: threw,
      expected: false,
    });
  });
});
