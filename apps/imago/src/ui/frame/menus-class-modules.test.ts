import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { accountItemClass, accountMenuClass, accountNameClass } from './avatar-menu/avatar-menu-class';
import {
  brandChipClass,
  driveInitialClass,
  driveLinkClass,
  driveMenuClass,
  driveNoteClass,
} from './brand-chip/brand-chip-class';
import {
  notFoundClass,
  notFoundDetailClass,
  notFoundLinkClass,
  notFoundTitleClass,
} from './not-found/not-found-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../app');
const appRoot = join(appDir, '..', '..');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: appRoot }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.menus.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

describe('brand chip classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the brand chip, the drive menu, a drive row (open and not), its initial and the menu note',
      should: 'return the token-locked class strings',
      actual: [brandChipClass, driveMenuClass, driveLinkClass(true), driveLinkClass(false), driveInitialClass, driveNoteClass],
      expected: [
        'flex size-rail-brand items-center justify-center rounded-lg border border-hairline bg-surface-raised font-semibold text-ink',
        'absolute top-0 left-rail-tooltip-x z-popover m-0 flex w-popover list-none flex-col rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised',
        'flex items-center gap-2 rounded-md px-2 py-row-y text-sm font-medium text-ink no-underline hover:no-underline bg-accent-soft',
        'flex items-center gap-2 rounded-md px-2 py-row-y text-sm font-medium text-ink no-underline hover:no-underline hover:bg-surface-overlay',
        'flex size-avatar-xs flex-none items-center justify-center rounded-md border border-hairline bg-surface-raised text-2xs font-semibold',
        'px-2 py-row-y text-sm text-ink-muted',
      ],
    });
  });
});

describe('account menu classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the account menu, the signed-in name and a menu row',
      should: 'return the token-locked class strings',
      actual: [accountMenuClass, accountNameClass, accountItemClass],
      expected: [
        'absolute bottom-0 left-rail-tooltip-x z-popover m-0 flex w-max list-none flex-col gap-1 rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised',
        'px-2 py-row-y text-xs text-ink-muted',
        'flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-row-y text-left text-sm font-medium text-ink no-underline hover:bg-surface-overlay hover:no-underline',
      ],
    });
  });
});

describe('not-found classes', () => {
  test('exact strings', () => {
    assert({
      given: 'the not-found object, its title, detail and link',
      should: 'return the token-locked class strings',
      actual: [notFoundClass, notFoundTitleClass, notFoundDetailClass, notFoundLinkClass],
      expected: [
        'flex h-full flex-col items-center justify-center gap-2 p-4 text-center',
        'm-0 text-md font-semibold text-ink',
        'm-0 text-sm text-ink-muted',
        'text-sm font-medium text-accent',
      ],
    });
  });
});

describe('frame menu class modules against the theme', () => {
  test('every class resolves', async () => {
    const classes = [
      brandChipClass,
      driveMenuClass,
      driveLinkClass(true),
      driveLinkClass(false),
      driveInitialClass,
      driveNoteClass,
      accountMenuClass,
      accountNameClass,
      accountItemClass,
      notFoundClass,
      notFoundTitleClass,
      notFoundDetailClass,
      notFoundLinkClass,
    ]
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);

    assert({
      given: `the ${classes.length} classes the brand chip, account menu and not-found modules emit`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
