import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { phaseOf } from './imago-phase';

describe('phaseOf()', () => {
  test("Imago's conversation", () => {
    assert({
      given: "a send waiting in Imago's conversation, then the viewer's own stream into it, then neither",
      should: 'think, then speak, then rest',
      actual: [
        phaseOf('c1', new Set(['c1']), []),
        phaseOf('c1', new Set(['c1']), ['c1']),
        phaseOf('c1', new Set(), []),
      ],
      expected: ['thinking', 'speaking', null],
    });
  });

  test("another agent's turn", () => {
    assert({
      given: 'a send and a stream in some other conversation, or no Imago conversation at all',
      should: "leave Imago's orb at rest",
      actual: [phaseOf('c1', new Set(['c2']), ['c2']), phaseOf(null, new Set(['c2']), ['c2'])],
      expected: [null, null],
    });
  });
});
