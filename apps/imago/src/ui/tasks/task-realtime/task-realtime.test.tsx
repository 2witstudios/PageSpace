import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { list, parent, task } from '../task-model/fixtures';
import { createCoalescer, concernsTree, treeRooms } from './task-realtime';

const tree = list('root', [parent('p', [parent('q', [task('x')])]), task('z')]);

describe('treeRooms', () => {
  test('every loaded list', () => {
    assert({
      given: 'a tree with two loaded levels of subtasks',
      should: 'name the root and every task page, leaves included, depth first',
      actual: treeRooms(tree),
      expected: ['root', 'page-p', 'page-q', 'page-x', 'page-z'],
    });
  });
});

describe('concernsTree', () => {
  const rooms = treeRooms(tree);
  test('an event in a sub-list', () => {
    assert({
      given: 'an event for a nested list the tree holds',
      should: 'concern the tree',
      actual: concernsTree({ pageId: 'page-q' }, rooms),
      expected: true,
    });
  });

  test('an event elsewhere', () => {
    assert({
      given: 'an event for some other list (the viewer’s own tasks channel)',
      should: 'not concern the tree',
      actual: concernsTree({ pageId: 'elsewhere' }, rooms),
      expected: false,
    });
  });

  test('an event with no page', () => {
    assert({
      given: 'an event that names no page',
      should: 'be taken as the tree’s own',
      actual: [concernsTree(undefined, rooms), concernsTree({}, rooms)],
      expected: [true, true],
    });
  });
});

describe('createCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a burst', () => {
    let runs = 0;
    const coalescer = createCoalescer(() => (runs += 1), 300);
    coalescer.schedule();
    coalescer.schedule();
    coalescer.schedule();
    const before = runs;
    vi.advanceTimersByTime(300);
    assert({
      given: 'three asks inside one window (a write and its two echoes)',
      should: 'run once, at the end of the window',
      actual: [before, runs],
      expected: [0, 1],
    });
  });

  test('a later ask', () => {
    let runs = 0;
    const coalescer = createCoalescer(() => (runs += 1), 300);
    coalescer.schedule();
    vi.advanceTimersByTime(300);
    coalescer.schedule();
    vi.advanceTimersByTime(300);
    assert({
      given: 'an ask after the first window has run',
      should: 'run again in a window of its own',
      actual: runs,
      expected: 2,
    });
  });

  test('a steady stream', () => {
    let runs = 0;
    const coalescer = createCoalescer(() => (runs += 1), 300);
    for (let tick = 0; tick < 6; tick += 1) {
      coalescer.schedule();
      vi.advanceTimersByTime(100);
    }
    assert({
      given: 'an ask every 100ms for 600ms',
      should: 'still run each window rather than wait for a lull',
      actual: runs,
      expected: 2,
    });
  });

  test('cancel', () => {
    let runs = 0;
    const coalescer = createCoalescer(() => (runs += 1), 300);
    coalescer.schedule();
    coalescer.cancel();
    vi.advanceTimersByTime(300);
    assert({
      given: 'a pending run cancelled, as on unmount',
      should: 'not run',
      actual: runs,
      expected: 0,
    });
  });
});
