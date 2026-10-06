import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { uiSlices } from './slices';
import { createInitialState } from './state';

describe('createInitialState()', () => {
  test('empty shell state', () => {
    assert({
      given: 'a fresh UI state',
      should: 'carry every registered slice’s initial resources and empty collections (no mock data)',
      actual: createInitialState(),
      expected: {
        resources: Object.assign({}, ...uiSlices.map((slice) => slice.resources())),
        collections: {},
      },
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
        first.resources.collapsedSections === second.resources.collapsedSections,
        first.resources.expandedTasks === second.resources.expandedTasks,
      ],
      expected: [false, false, false, false, false],
    });
  });
});
