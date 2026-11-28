import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { imagoOrbClass } from './imago-orb-class';
import { renderImagoOrb } from './imago-orb.render';

describe('renderImagoOrb()', () => {
  test('named', () => {
    assert({
      given: 'an orb with a label',
      should: 'draw a canvas named for screen readers',
      actual: renderToString(renderImagoOrb({ size: 'hero', fallback: false, label: 'Imago' })),
      expected: `<canvas class="${imagoOrbClass('hero', false)}" data-imago-orb="hero" role="img" aria-label="Imago"></canvas>`,
    });
  });

  test('beside its name', () => {
    assert({
      given: 'an orb next to the visible word "Imago"',
      should: 'hide the canvas from screen readers',
      actual: renderToString(renderImagoOrb({ size: 'tile', fallback: true })),
      expected: `<canvas class="${imagoOrbClass('tile', true)}" data-imago-orb="tile" aria-hidden="true"></canvas>`,
    });
  });

  test('in a retained surface', () => {
    assert({
      given: "a classic tree row's own size classes",
      should: 'use them in place of the token size',
      actual: renderToString(renderImagoOrb({ size: 'glyph', fallback: false, className: 'h-4 w-4' })),
      expected: '<canvas class="h-4 w-4 block flex-none" data-imago-orb="glyph" aria-hidden="true"></canvas>',
    });
  });

  test('on a dark surface', () => {
    assert({
      given: "the spine's Chat tile",
      should: 'mark the surface for the engine to light',
      actual: renderToString(renderImagoOrb({ size: 'rail', fallback: false, surface: 'dark' })),
      expected: `<canvas class="${imagoOrbClass('rail', false)}" data-imago-orb="rail" data-orb-surface="dark" aria-hidden="true"></canvas>`,
    });
  });
});
