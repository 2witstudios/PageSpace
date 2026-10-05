import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from './state';

describe('createInitialState()', () => {
  test('empty shell state', () => {
    assert({
      given: 'a fresh UI state',
      should: 'carry empty resources and collections (no mock data)',
      actual: createInitialState(),
      expected: { resources: {}, collections: {} },
    });
  });

  test('independent snapshots', () => {
    const first = createInitialState();
    const second = createInitialState();

    assert({
      given: 'two fresh UI states',
      should: 'share no object between them',
      actual: [
        first === second,
        first.resources === second.resources,
        first.collections === second.collections,
      ],
      expected: [false, false, false],
    });
  });
});
