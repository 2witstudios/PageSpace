import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { presenceDotClass } from './presence-dot-class';
import { presences } from '../../types/presence/presence';

const base =
  'inline-block size-presence-dot rounded-round border-2 border-surface';

describe('presenceDotClass()', () => {
  test('fills', () => {
    assert({
      given: 'each presence value',
      should: 'add a distinct fill token to the shared ringed dot',
      actual: presences.map(presenceDotClass),
      expected: [
        `${base} bg-online`,
        `${base} bg-warn`,
        `${base} bg-ink-faint`,
      ],
    });
  });
});
