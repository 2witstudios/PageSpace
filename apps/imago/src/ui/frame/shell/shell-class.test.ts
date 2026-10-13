import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss, { type Root } from 'postcss';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { listPaneClass } from '../list-pane/list-pane-class';
import { paneClass } from '../pane/pane-class';
import { paneLayout, stageFor, type HideableSection } from '../stage/stage';
import {
  chatSlotClass,
  columnClass,
  listSlotClass,
  objectSlotClass,
  railClass,
  shellClass,
} from './shell-class';

const widths = (pathname: string, collapsedSections: readonly HideableSection[] = []): readonly string[] => {
  const layout = paneLayout(stageFor(pathname), { collapsedSections });
  return [listSlotClass(layout), objectSlotClass(layout), chatSlotClass(layout)];
};

describe('shell slot widths', () => {
  test('a drive’s chat', () => {
    assert({
      given: 'the drive chat stage, then with its history hidden',
      should: 'open the history beside the chat and close the object; hidden, give the chat the frame',
      actual: [widths('/drive-1'), widths('/drive-1', ['chat'])],
      expected: [
        ['w-list-pane', 'w-0', 'w-stage-chat-list'],
        ['w-0', 'w-0', 'w-stage-chat'],
      ],
    });
  });

  test('stage 2', () => {
    assert({
      given: 'a section’s list',
      should: 'open the wide list and give the chat the rest',
      actual: [widths('/drive-1/files'), widths('/drive-1/tasks'), widths('/dm')],
      expected: [
        ['w-list-pane', 'w-0', 'w-stage-chat-list'],
        ['w-list-pane', 'w-0', 'w-stage-chat-list'],
        ['w-list-pane', 'w-0', 'w-stage-chat-list'],
      ],
    });
  });

  test('stage 3', () => {
    assert({
      given: 'an open page or conversation',
      should: 'narrow the list to the tree, fill with the object and fix the chat',
      actual: [widths('/drive-1/files/page-1'), widths('/dm/conversation-1')],
      expected: [
        ['w-tree-pane', 'w-stage-object-tree', 'w-chat-pane'],
        ['w-tree-pane', 'w-stage-object-tree', 'w-chat-pane'],
      ],
    });
  });

  test('stage 3 with its list hidden', () => {
    assert({
      given: 'an open page with its section collapsed',
      should: 'close the tree and give the object its room',
      actual: widths('/drive-1/files/page-1', ['files']),
      expected: ['w-0', 'w-stage-object', 'w-chat-pane'],
    });
  });

  test('an object with no list', () => {
    assert({
      given: 'drive settings and the account',
      should: 'open the object beside the fixed chat with no list',
      actual: [widths('/drive-1/settings'), widths('/account')],
      expected: [
        ['w-0', 'w-stage-object', 'w-chat-pane'],
        ['w-0', 'w-stage-object', 'w-chat-pane'],
      ],
    });
  });
});

describe('shell frame classes', () => {
  test('the frame', () => {
    assert({
      given: 'the shell',
      should: 'fill the viewport as one row that never scrolls',
      actual: shellClass,
      expected: 'flex h-screen w-full overflow-hidden',
    });
  });

  test('the rail', () => {
    assert({
      given: 'the rail slot',
      should: 'be the one 64px glass column with a hairline, lifted above the panes',
      actual: railClass,
      expected:
        'relative z-rail flex h-full w-rail-width flex-none flex-col items-center gap-rail-gap border-r border-hairline py-rail-y surface-glass',
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
  // `surface-glass` is a backdrop-filter, so the rail and the list pane are
  // each a stacking context. Without a z-index of its own the rail paints
  // under the later list pane, and so do its tooltips and the ⋯ menu.
  test('the rail is its own positioned layer over the panes', async () => {
    const list = listPaneClass('list');
    const pane = paneClass('w-list-pane');
    const css = await compile([...railClass.split(' '), ...list.split(' '), ...pane.split(' ')]);
    const rail = declarations(css, railClass);
    const zIndex = rail.get('z-index') ?? '';
    const zToken = /^var\((--[\w-]+)\)$/.exec(zIndex)?.[1];
    const panes = [declarations(css, list), declarations(css, pane)];

    assert({
      given: 'the glass rail beside a glass list pane',
      should: 'position the rail with a named z-index token above 0, while the panes stay unlayered',
      actual: [
        rail.has('backdrop-filter'),
        rail.get('position'),
        zToken,
        Number(zToken === undefined ? Number.NaN : token(css, zToken)) > 0,
        panes.map((decls) => decls.has('z-index')),
      ],
      expected: [true, 'relative', '--z-index-rail', true, [false, false]],
    });
  });
});
