import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderIcon } from '../components/icon/icon.render';
import { imagoOrbClass } from './imago-orb/imago-orb-class';
import { renderPageIcon } from './page-icon';

describe('renderPageIcon()', () => {
  test('an agent page', () => {
    assert({
      given: 'any page but Imago’s',
      should: 'draw its type icon',
      actual: renderToString(renderPageIcon({ icon: 'sparkle', size: 15 })),
      expected: renderToString(renderIcon({ name: 'sparkle', size: 15 })),
    });
  });

  test('Imago’s page', () => {
    assert({
      given: 'Imago’s own page',
      should: 'draw Imago’s orb at glyph size instead',
      actual: renderToString(renderPageIcon({ icon: 'sparkle', size: 15, imago: true })),
      expected: `<canvas class="${imagoOrbClass('glyph', false)}" data-imago-orb="glyph" aria-hidden="true"></canvas>`,
    });
  });
});
