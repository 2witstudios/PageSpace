import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss, { type Root } from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { listPaneClass } from '../list-pane/list-pane-class';
import { paneClass } from '../pane/pane-class';
import { columnsFor, type ColumnState } from '../stage/columns';
import { stageFor } from '../stage/stage';
import {
  chatSlotClass,
  columnClass,
  columnsRowClass,
  emptySlotClass,
  listSlotClass,
  objectSlotClass,
  railClass,
  shellClass,
  stageSheetClass,
} from './shell-class';

const open: ColumnState = { paneCollapsed: false, imagoCollapsed: false, imagoClosed: false };

/** The list, page, Imago and empty-middle widths for a path and the viewer's column state. */
const widths = (pathname: string, state: Partial<ColumnState> = {}): readonly string[] => {
  const stage = stageFor(pathname);
  const columns = columnsFor(stage, { ...open, ...state });
  return [listSlotClass(columns, stage.list), objectSlotClass(columns), chatSlotClass(columns), emptySlotClass(columns)];
};

describe('shell slot widths', () => {
  test('a drive’s chat', () => {
    assert({
      given: 'the drive chat stage, then with its history closed',
      should: 'open the history beside Imago on the ground; closed, give Imago the frame',
      actual: [widths('/drive-1'), widths('/drive-1', { paneCollapsed: true })],
      expected: [
        ['w-list-pane', 'w-0', 'grow', 'w-0'],
        ['w-0', 'w-0', 'grow', 'w-0'],
      ],
    });
  });

  test('stage 2', () => {
    assert({
      given: 'a section’s list',
      should: 'open the wide list and give Imago the rest',
      actual: [widths('/drive-1/files'), widths('/dm')],
      expected: [
        ['w-list-pane', 'w-0', 'grow', 'w-0'],
        ['w-list-pane', 'w-0', 'grow', 'w-0'],
      ],
    });
  });

  test('the Tasks index', () => {
    assert({
      given: 'a drive’s Tasks index, the list open and no object',
      should: 'leave the middle to Imago as the ground, as every section index does',
      actual: widths('/drive-1/tasks'),
      expected: ['w-list-pane', 'w-0', 'grow', 'w-0'],
    });
  });

  test('a Tasks smart view', () => {
    assert({
      given: 'a smart view opened from the Tasks pane',
      should: 'narrow the pane, fill the middle with the view and dock Imago',
      actual: widths('/drive-1/tasks/view/today'),
      expected: ['w-tree-pane', 'grow', 'w-chat-pane', 'w-0'],
    });
  });

  test('stage 3', () => {
    assert({
      given: 'an open page or conversation',
      should: 'narrow the list to the tree, fill with the page and dock Imago',
      actual: [widths('/drive-1/files/page-1'), widths('/dm/conversation-1')],
      expected: [
        ['w-tree-pane', 'grow', 'w-chat-pane', 'w-0'],
        ['w-tree-pane', 'grow', 'w-chat-pane', 'w-0'],
      ],
    });
  });

  test('stage 3 with its pane closed', () => {
    assert({
      given: 'an open page with its pane closed',
      should: 'close the tree and let the page take its room',
      actual: widths('/drive-1/files/page-1', { paneCollapsed: true }),
      expected: ['w-0', 'grow', 'w-chat-pane', 'w-0'],
    });
  });

  test('settings and the account', () => {
    assert({
      given: 'drive settings and the account, alone and then with a screen open',
      should: 'show the nav beside Imago as the ground, then narrow it beside the screen and dock Imago',
      actual: [widths('/drive-1/settings'), widths('/account'), widths('/drive-1/settings/general'), widths('/account/display')],
      expected: [
        ['w-list-pane', 'w-0', 'grow', 'w-0'],
        ['w-list-pane', 'w-0', 'grow', 'w-0'],
        ['w-tree-pane', 'grow', 'w-chat-pane', 'w-0'],
        ['w-tree-pane', 'grow', 'w-chat-pane', 'w-0'],
      ],
    });
  });

  test('Imago collapsed', () => {
    assert({
      given: 'Imago collapsed beside a page, then with no page open',
      should: 'close Imago’s column beside the page, and ignore the collapse where Imago is the ground',
      actual: [widths('/drive-1/files/page-1', { imagoCollapsed: true }), widths('/drive-1', { imagoCollapsed: true })],
      expected: [
        ['w-tree-pane', 'grow', 'w-0', 'w-0'],
        ['w-list-pane', 'w-0', 'grow', 'w-0'],
      ],
    });
  });

  test('Imago closed on the ground', () => {
    assert({
      given: 'Imago closed with no page open, then a page opened',
      should: 'give the middle to the empty area, then dock Imago beside the page again',
      actual: [widths('/drive-1', { imagoClosed: true }), widths('/drive-1/files/page-1', { imagoClosed: true })],
      expected: [
        ['w-list-pane', 'w-0', 'w-0', 'grow'],
        ['w-tree-pane', 'grow', 'w-chat-pane', 'w-0'],
      ],
    });
  });
});

describe('shell frame classes', () => {
  test('the frame', () => {
    assert({
      given: 'the shell',
      should: 'fill the viewport as one row on the spine’s blue that never scrolls',
      actual: shellClass,
      expected: 'flex h-dvh w-full overflow-hidden bg-spine',
    });
  });

  test('the stage sheet', () => {
    assert({
      given: 'the stage sheet and the columns row inside it',
      should: 'round the sheet’s top-left, lift it off the spine, and stack the tab bar over a row that fills the rest',
      actual: [stageSheetClass, columnsRowClass],
      expected: [
        'mt-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-stage bg-background shadow-sheet',
        'relative flex min-h-0 flex-1',
      ],
    });
  });

  test('the rail', () => {
    assert({
      given: 'the rail slot',
      should: 'be the one 72px spine-blue column, lifted above the panes',
      actual: railClass,
      expected:
        'relative z-rail flex h-full w-rail-width flex-none flex-col items-center gap-rail-gap bg-spine py-rail-y text-spine-ink',
    });
  });

  test('a column', () => {
    assert({
      given: 'the object and chat columns inside their panes',
      should: 'stack the header over a body that scrolls on its own',
      actual: columnClass,
      expected: 'flex h-full w-full min-w-0 flex-col',
    });
  });
});

const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../../app');

/** The real globals.css compiled with exactly the given candidate classes. */
const compile = async (classes: readonly string[]): Promise<Root> => {
  const source = `${readFileSync(join(appDir, 'globals.css'), 'utf8')}\n@source inline("${classes.join(' ')}");`;
  const result = await postcss([tailwind({ base: join(appDir, '..', '..') }) as postcss.AcceptedPlugin]).process(
    source,
    { from: join(appDir, 'globals.stacking.css') },
  );
  return postcss.parse(result.css);
};

/** The declarations each class compiles to, by property. */
const declarations = (css: Root, classList: string): Map<string, string> => {
  const found = new Map<string, string>();
  const names = new Set(classList.split(' ').map((cls) => `.${cls}`));
  css.walkRules((rule) => {
    if (!names.has(rule.selector)) return;
    rule.walkDecls((decl) => {
      found.set(decl.prop, decl.value);
    });
  });
  return found;
};

/** A theme token's value, from the compiled :root block. */
const token = (css: Root, name: string): string | undefined => {
  let value: string | undefined;
  css.walkDecls(name, (decl) => {
    value ??= decl.value;
  });
  return value;
};

describe('the rail above the panes', () => {
  // The list pane is glass (a backdrop-filter), so it is a stacking context
  // painted after the rail. Without a z-index of its own the rail paints
  // under it, and so do its tooltips and the drive and account menus.
  test('the rail is its own positioned layer over the panes', async () => {
    const list = listPaneClass('list');
    const pane = paneClass('w-list-pane');
    const css = await compile([...railClass.split(' '), ...list.split(' '), ...pane.split(' ')]);
    const rail = declarations(css, railClass);
    const zIndex = rail.get('z-index') ?? '';
    const zToken = /^var\((--[\w-]+)\)$/.exec(zIndex)?.[1];
    const panes = [declarations(css, list), declarations(css, pane)];

    assert({
      given: 'the opaque spine beside a glass list pane',
      should: 'position the rail with a named z-index token above 0, without glass, while the panes stay unlayered',
      actual: [
        rail.has('backdrop-filter'),
        rail.get('position'),
        zToken,
        Number(zToken === undefined ? Number.NaN : token(css, zToken)) > 0,
        panes.map((decls) => decls.has('z-index')),
      ],
      expected: [false, 'relative', '--z-index-rail', true, [false, false]],
    });
  });
});

describe('shell classes against the theme', () => {
  test('every class resolves', async () => {
    const classes = [shellClass, stageSheetClass, columnsRowClass, 'w-list-pane w-tree-pane w-chat-pane w-0']
      .flatMap((list) => list.split(' '))
      .filter((cls, index, all) => all.indexOf(cls) === index);
    const css = await compile(classes);
    const selectors = new Set<string>();
    css.walkRules((rule) => {
      selectors.add(rule.selector);
    });

    assert({
      given: `the ${classes.length} classes the frame, the stage sheet and the slot widths emit`,
      should: 'each generate a rule from the token-locked theme',
      actual: classes.filter((cls) => !selectors.has(`.${cls.replace(/[:/.]/g, (char) => `\\${char}`)}`)),
      expected: [],
    });
  });
});
