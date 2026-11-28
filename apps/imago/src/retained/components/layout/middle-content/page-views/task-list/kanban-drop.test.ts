import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { kanbanDropStatus } from './kanban-drop';

const columns = {
  pending: [{ id: 'a' }, { id: 'b' }],
  in_progress: [{ id: 'c' }],
  completed: [],
};
const order = ['pending', 'in_progress', 'completed'];

describe('kanbanDropStatus', () => {
  test('a card dropped on another card moves to that card column\'s status', () => {
    assert({
      given: 'a drop over card c, which sits in in_progress',
      should: 'resolve to in_progress',
      actual: kanbanDropStatus(columns, order, 'c'),
      expected: 'in_progress',
    });
  });

  test('a card dropped on an empty column moves to that column status', () => {
    assert({
      given: 'a drop over the empty completed column',
      should: 'resolve to completed',
      actual: kanbanDropStatus(columns, order, 'completed'),
      expected: 'completed',
    });
  });

  test('a drop on something the board does not know moves nothing', () => {
    assert({
      given: 'a drop over an id that is neither a card nor a column',
      should: 'resolve to null',
      actual: kanbanDropStatus(columns, order, 'nowhere'),
      expected: null,
    });
  });
});
