import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { imagoOrbClass, orbSizes } from './imago-orb-class';

describe('imagoOrbClass()', () => {
  test('each size', () => {
    assert({
      given: 'the hero, a post author, the rail tile, the head tile, a picker row and the glyph',
      should: 'size a block canvas from the orb tokens',
      actual: orbSizes.map((size) => imagoOrbClass(size, false)),
      expected: [
        'block flex-none size-orb-hero',
        'block flex-none size-avatar-sm',
        'block flex-none size-orb-rail',
        'block flex-none size-orb-tile',
        'block flex-none size-orb-row -m-orb-row-overhang',
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
