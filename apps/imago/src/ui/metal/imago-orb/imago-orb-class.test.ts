import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { imagoOrbClass, orbSizes } from './imago-orb-class';

describe('imagoOrbClass()', () => {
  test('each size', () => {
    assert({
      given: 'the hero, a post author, the head tile, a picker row and the glyph',
      should: 'size a block canvas from the orb and agent tokens',
      actual: orbSizes.map((size) => imagoOrbClass(size, false)),
      expected: [
        'block flex-none size-orb-hero',
        'block flex-none size-avatar-sm',
        'block flex-none size-agent-tile',
        'block flex-none size-agent-row-tile',
        'block flex-none size-orb-glyph',
      ],
    });
  });

  test('without the engine', () => {
    assert({
      given: 'no WebGL2',
      should: 'paint the still chrome ball',
      actual: imagoOrbClass('glyph', true),
      expected: 'block flex-none size-orb-glyph orb-chrome',
    });
  });
});
