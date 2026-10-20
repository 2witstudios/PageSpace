import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { list, parent, task } from '../task-model/fixtures';
import { concernsTree, treeRooms } from './task-realtime';

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
