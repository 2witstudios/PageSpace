import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  overflowLinkClass,
  overflowMenuClass,
  railChipClass,
  railHitClass,
  railListClass,
  railPinnedClass,
  railTooltipClass,
  railUnreadClass,
} from './rail-button-class';

const hitBase =
  'group relative flex size-rail-hit flex-none items-center justify-center rounded-lg no-underline hover:no-underline';
const chipBase =
  'flex size-rail-chip items-center justify-center rounded-lg transition-colors duration-120 ease-standard';

describe('railHitClass()', () => {
  test('hit box', () => {
    assert({
      given: 'a linked and a driveless rail item',
      should: 'keep the 44px box and change only the cursor',
      actual: [railHitClass(true), railHitClass(false)],
      expected: [`${hitBase} cursor-pointer`, `${hitBase} cursor-default`],
    });
  });
});

describe('railChipClass()', () => {
  test('states', () => {
    assert({
      given: 'the active, linked and driveless states',
      should: 'give each its own fill and ink, the active one a soft tint with ink rather than blue',
      actual: [railChipClass(true, true), railChipClass(false, true), railChipClass(false, false)],
      expected: [
        `${chipBase} bg-accent-soft text-ink`,
        `${chipBase} text-ink-muted group-hover:bg-surface-overlay group-hover:text-ink`,
        `${chipBase} text-ink-faint`,
      ],
    });
  });
});

describe('the rail’s fixed classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the rail lists, tooltip, unread corner and overflow menu',
      should: 'stay these token-locked strings',
      actual: [
        railListClass,
        railPinnedClass,
        railTooltipClass,
        railUnreadClass,
        overflowMenuClass,
        overflowLinkClass,
      ],
      expected: [
        'm-0 flex list-none flex-col items-center gap-rail-gap p-0',
        'm-0 mt-auto flex list-none flex-col items-center gap-rail-gap p-0',
        'pointer-events-none invisible absolute top-1/2 left-rail-tooltip-x z-30 -translate-y-1/2 rounded-md border border-hairline bg-surface-raised px-2 py-1 text-2xs whitespace-nowrap text-ink opacity-0 shadow-2 transition-opacity duration-120 ease-standard group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100',
        'absolute top-0 right-0',
        'absolute top-0 left-rail-tooltip-x z-30 m-0 flex w-menu list-none flex-col rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised',
        'flex items-center gap-2 rounded-md px-2 py-row-y text-sm font-medium text-ink no-underline hover:bg-surface-overlay hover:no-underline',
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
      railHitClass(true),
      railHitClass(false),
      railChipClass(true, true),
      railChipClass(false, true),
      railChipClass(false, false),
      railListClass,
      railPinnedClass,
      railTooltipClass,
      railUnreadClass,
      overflowMenuClass,
      overflowLinkClass,
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
