import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { presences } from '../../types/presence/presence';
import { presenceDotClass } from './presence-dot-class';
import { renderPresenceDot } from './presence-dot.render';

describe('renderPresenceDot()', () => {
  test('a named dot for each presence', () => {
    assert({
      given: 'each presence value',
      should: 'render its dot as an image named with that presence',
      actual: presences.map((presence) =>
        renderToString(renderPresenceDot({ presence })),
      ),
      expected: [
        `<span class="${presenceDotClass('online')}" role="img" aria-label="Online"></span>`,
        `<span class="${presenceDotClass('away')}" role="img" aria-label="Away"></span>`,
        `<span class="${presenceDotClass('offline')}" role="img" aria-label="Offline"></span>`,
      ],
    });
  });
});
