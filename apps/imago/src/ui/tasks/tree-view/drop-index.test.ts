import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { list, parent, task } from '../task-model/fixtures';
import { dropIndex } from './tree-view';

const tree = list('root', [task('a'), parent('p', [task('x'), task('y')]), task('b')]);

describe('dropIndex', () => {
  test('a sibling', () => {
    assert({
      given: 'a row dropped on a sibling further down',
      should: 'land at that sibling’s index',
      actual: dropIndex(tree, 'a', 'b'),
      expected: 2,
    });
  });

  test('a nested sibling', () => {
    assert({
      given: 'a subtask dropped on the other subtask of its parent',
      should: 'land at that subtask’s index in the parent’s list',
      actual: dropIndex(tree, 'y', 'x'),
      expected: 0,
    });
  });

  test('another level', () => {
    assert({
      given: 'a row dropped on a row of another level, on itself, and on nothing',
      should: 'move nothing',
      actual: [dropIndex(tree, 'a', 'x'), dropIndex(tree, 'a', 'a'), dropIndex(tree, 'a', null)],
      expected: [null, null, null],
    });
  });
});
