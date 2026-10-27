import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  railTooltipClass,
  spineCountClass,
  spineDividerClass,
  spineListClass,
  spineMarkerClass,
  spineTileClass,
} from './rail-button-class';

const tileBase =
  'group relative flex flex-none items-center justify-center no-underline transition-colors duration-120 ease-standard hover:no-underline';
const primary = `${tileBase} size-spine-tile rounded-spine-tile`;
const small = `${tileBase} size-spine-tile-small rounded-lg`;

describe('spineTileClass()', () => {
  test('primary tiles', () => {
    assert({
      given: 'a 48px section tile active, linked and driveless',
      should: 'fill the active one white with white ink, and keep the rest quiet, hovering only when linked',
      actual: [spineTileClass('primary', true), spineTileClass('primary', false), spineTileClass('primary', false, false)],
      expected: [
        `${primary} bg-spine-active text-spine-on`,
        `${primary} text-spine-quiet cursor-pointer hover:bg-spine-hover`,
        `${primary} text-spine-quiet cursor-default`,
      ],
    });
  });

  test('small tiles', () => {
    assert({
      given: 'a 40px tool tile active, linked and driveless',
      should: 'share the active fill and sit dimmer than the sections otherwise',
      actual: [spineTileClass('small', true), spineTileClass('small', false), spineTileClass('small', false, false)],
      expected: [
        `${small} bg-spine-active text-spine-on`,
        `${small} text-spine-dim cursor-pointer hover:bg-spine-hover`,
        `${small} text-spine-dim cursor-default`,
      ],
    });
  });
});

describe('spineMarkerClass()', () => {
  test('marker heights', () => {
    const marker = 'absolute top-1/2 w-spine-marker -translate-y-1/2 rounded-r-sm bg-spine-marker';
    assert({
      given: 'the active marker beside a section tile and beside a tool',
      should: 'sit at the spine’s edge, taller beside the larger tile',
      actual: [spineMarkerClass('primary'), spineMarkerClass('small')],
      expected: [`${marker} -left-3 h-spine-marker-tall`, `${marker} -left-4 h-spine-marker-short`],
    });
  });
});

describe('the spine’s fixed classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the spine’s count, lists, divider and tooltip',
      should: 'stay these token-locked strings',
      actual: [spineCountClass, spineListClass, spineDividerClass, railTooltipClass],
      expected: [
        'absolute top-1 right-1 flex h-spine-count min-w-spine-count items-center justify-center rounded-round bg-notice px-1 text-badge leading-none font-bold text-notice-ink',
        'm-0 flex list-none flex-col items-center gap-rail-gap p-0',
        'my-2 h-px w-spine-divider flex-none bg-spine-active',
        'pointer-events-none invisible fixed top-0 left-0 z-popover -translate-y-1/2 rounded-md border border-hairline bg-surface-raised px-2 py-1 text-2xs whitespace-nowrap text-ink opacity-0 shadow-2 transition-opacity duration-120 ease-standard pointer-fine:group-hover:visible pointer-fine:group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100',
      ],
    });
  });
});

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.rail.css'),
  });
  return result.css;
};

const escape = (cls: string): string => cls.replace(/[:/.]/g, (char) => `\\${char}`);

describe('rail classes against the theme', () => {
  test('every class resolves', async () => {
    const classes = [
      spineTileClass('primary', true),
      spineTileClass('primary', false),
      spineTileClass('primary', false, false),
      spineTileClass('small', true),
      spineTileClass('small', false),
      spineTileClass('small', false, false),
      spineMarkerClass('primary'),
      spineMarkerClass('small'),
      spineCountClass,
      spineListClass,
      spineDividerClass,
      railTooltipClass,
    ]
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index)
      // `group` is a marker for group-* variants and emits no rule of its own.
      .filter((cls) => cls !== 'group');
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the rail emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(`.${escape(cls)}`)),
      expected: [],
    });
  });
});
