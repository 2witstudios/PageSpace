import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  folderBodyClass,
  folderBrowseClass,
  folderCellClass,
  folderContentClass,
  folderCountClass,
  folderCreatingClass,
  folderDotClass,
  folderHeadClass,
  folderHeadEndClass,
  folderKindClass,
  folderLinkClass,
  folderNameClass,
  folderRowClass,
  folderTableClass,
  folderViewClass,
  folderWhenClass,
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

const parts = [
  folderViewClass,
  folderCountClass,
  folderBrowseClass,
  folderBodyClass,
  folderContentClass,
  folderTableClass,
  folderHeadClass,
  folderHeadEndClass,
  folderCellClass,
  folderDotClass,
  folderLinkClass,
  folderNameClass,
  folderCreatingClass,
  folderKindClass,
  folderWhenClass,
];

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
      given: 'the browser, its tools strip, its table and the cells of a row',
      should: 'fill the object column under a strip, with a 44px row per page: name at full ink, kind and time muted',
      actual: [
        folderViewClass,
        folderCountClass,
        folderBrowseClass,
        folderBodyClass,
        folderContentClass,
        folderTableClass,
        folderHeadClass,
        folderHeadEndClass,
        folderCellClass,
        folderDotClass,
        folderLinkClass,
        folderNameClass,
        folderCreatingClass,
        folderKindClass,
        folderWhenClass,
      ],
      expected: [
        'flex h-full min-h-0 flex-col',
        'whitespace-nowrap text-xs text-ink-muted',
        'ml-2 inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-sm text-ink no-underline hover:bg-surface-overlay',
        'min-h-0 flex-1 overflow-auto px-10 pb-12 pt-5',
        'mx-auto max-w-folder',
        'w-full border-collapse text-sm',
        'border-b border-hairline px-2 pb-2 text-left text-xs font-medium text-ink-muted',
        'border-b border-hairline px-2 pb-2 text-left text-xs font-medium text-ink-muted text-right',
        'h-10 px-2',
        'inline-block size-2 shrink-0 rounded-full bg-current',
        'flex min-w-0 items-center gap-2 font-medium text-ink no-underline hover:no-underline',
        'min-w-0 truncate',
        'text-xs font-normal text-ink-faint',
        'h-10 whitespace-nowrap px-2 text-ink-muted',
        'h-10 whitespace-nowrap px-2 text-right tabular-nums text-ink-muted',
      ],
    });
  });

  test('every class resolves against the theme', async () => {
    const classes = [folderRowClass(false), folderRowClass(true), ...parts]
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
