import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { filesFilterClass, filesNoteClass, filesTreeClass } from '../files-pane/files-pane-class';
import {
  treeCaretClass,
  treeChildrenClass,
  treeCountClass,
  treeLinkClass,
  treeNameClass,
  treeRowClass,
  treeSpacerClass,
  treeToggleClass,
} from './tree-row-class';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<string> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: join(appDir, '..', '..') }) as postcss.AcceptedPlugin]).process(source, {
    from: join(appDir, 'globals.files.css'),
  });
  return result.css;
};

const selectorOf = (cls: string): string => `.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`;

const base =
  'flex h-8 w-full items-center gap-1 rounded-lg px-1 text-left text-sm transition-colors duration-120 ease-standard';
const resting = 'font-normal text-ink-muted hover:bg-surface-overlay hover:text-ink';
const open = 'bg-accent-soft font-normal text-ink';
const caretBase = 'inline-flex transition-transform duration-120 ease-standard';

describe('treeRowClass()', () => {
  test('selection', () => {
    assert({
      given: 'a resting row and the open page’s row',
      should: 'share one quiet 32px row, and lift the open one to full ink on the soft accent tint',
      actual: [treeRowClass({ selected: false, pending: false }), treeRowClass({ selected: true, pending: false })],
      expected: [`${base} ${resting}`, `${base} ${open}`],
    });
  });

  test('a row being created', () => {
    assert({
      given: 'a row the server has not listed yet, resting and open',
      should: 'fade it, keeping its selection tint',
      actual: [treeRowClass({ selected: false, pending: true }), treeRowClass({ selected: true, pending: true })],
      expected: [`${base} ${resting} opacity-60`, `${base} ${open} opacity-60`],
    });
  });
});

describe('treeCaretClass()', () => {
  test('disclosure', () => {
    assert({
      given: 'an open and a closed page',
      should: 'turn the caret down only while the page is open',
      actual: [treeCaretClass(true), treeCaretClass(false)],
      expected: [`${caretBase} rotate-90`, `${caretBase} rotate-0`],
    });
  });
});

describe('tree row parts', () => {
  test('exact classes', () => {
    assert({
      given: 'the link, toggle, spacer, name, count and nested level',
      should: 'fill the row with the link, keep a 16px caret slot on every row, and step each level in',
      actual: [treeLinkClass, treeToggleClass, treeSpacerClass, treeNameClass, treeCountClass, treeChildrenClass],
      expected: [
        'flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 text-inherit no-underline hover:no-underline',
        'inline-flex size-4 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-ink-faint hover:text-ink',
        'size-4 flex-none',
        'min-w-0 flex-1 truncate',
        'flex-none text-2xs text-ink-faint',
        'flex flex-col gap-1 pl-tree-step',
      ],
    });
  });

  test('the pane around the tree', () => {
    assert({
      given: 'the filter row, the tree and a pane note',
      should: 'keep the filter on its own row and the note muted',
      actual: [filesFilterClass, filesTreeClass, filesNoteClass],
      expected: ['flex flex-none', 'flex flex-col gap-1', 'px-2 text-sm text-ink-muted'],
    });
  });

  test('every class resolves against the theme', async () => {
    const classes = [
      ...[false, true].flatMap((selected) => [false, true].map((pending) => treeRowClass({ selected, pending }))),
      ...[false, true].map(treeCaretClass),
      treeLinkClass,
      treeToggleClass,
      treeSpacerClass,
      treeNameClass,
      treeCountClass,
      treeChildrenClass,
      filesFilterClass,
      filesTreeClass,
      filesNoteClass,
    ]
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);
    assert({
      given: `the ${classes.length} classes the files tree pane emits`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !css.includes(selectorOf(cls))),
      expected: [],
    });
  });

  test('a 32px row', async () => {
    const css = await compile(['h-8']);
    assert({
      given: 'the row height',
      should: 'be 32px',
      actual: /--spacing-8: 32px/.test(css) && /\.h-8 \{\s*height: var\(--spacing-8\)/.test(css),
      expected: true,
    });
  });
});
