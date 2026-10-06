import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  folderCellClass,
  folderCrumbClass,
  folderCrumbCurrentClass,
  folderCrumbItemClass,
  folderCrumbSeparatorClass,
  folderHeadClass,
  folderLinkClass,
  folderMetaClass,
  folderNameClass,
  folderPathClass,
  folderRowClass,
  folderTableClass,
  folderViewClass,
} from './folder-view-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: join(appDir, '..', '..') }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.folder.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

const row = 'border-b border-hairline transition-colors duration-120 ease-standard hover:bg-surface-overlay';

describe('folderRowClass()', () => {
  test('a listed row and one being created', () => {
    assert({
      given: 'a row the drive tree lists, and a create the server has not answered',
      should: 'share one hairline-ruled row that tints on hover, fading the one still being created',
      actual: [folderRowClass(false), folderRowClass(true)],
      expected: [row, `${row} opacity-60`],
    });
  });
});

describe('folder browser parts', () => {
  test('exact classes', () => {
    assert({
      given: 'the browser, its path bar, its table and the cells of a row',
      should: 'stack the path over a full-width list of quiet 32px rows: name at full ink, kind and time muted',
      actual: [
        folderViewClass,
        folderPathClass,
        folderCrumbItemClass,
        folderCrumbClass,
        folderCrumbCurrentClass,
        folderCrumbSeparatorClass,
        folderTableClass,
        folderHeadClass,
        folderCellClass,
        folderLinkClass,
        folderNameClass,
        folderMetaClass,
      ],
      expected: [
        'flex h-full flex-col gap-4 p-4',
        'flex min-w-0 flex-wrap items-center gap-1 text-sm text-ink-muted',
        'flex items-center gap-1',
        'text-ink-muted no-underline hover:text-ink',
        'font-semibold text-ink',
        'text-ink-faint',
        'w-full border-collapse text-sm',
        'h-8 border-b border-hairline px-2 text-left text-xs font-medium text-ink-faint',
        'h-8 px-2',
        'flex min-w-0 items-center gap-2 text-ink no-underline hover:no-underline',
        'min-w-0 truncate',
        'h-8 whitespace-nowrap px-2 text-ink-muted',
      ],
    });
  });

  test('every class resolves against the theme', async () => {
    const classes = [
      folderRowClass(false),
      folderRowClass(true),
      folderViewClass,
      folderPathClass,
      folderCrumbItemClass,
      folderCrumbClass,
      folderCrumbCurrentClass,
      folderCrumbSeparatorClass,
      folderTableClass,
      folderHeadClass,
      folderCellClass,
      folderLinkClass,
      folderNameClass,
      folderMetaClass,
    ]
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the folder browser emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });
});
