import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import {
  closeTab,
  imagoPathOf,
  isNewTabClick,
  navigateTabs,
  newTab,
  openTabInBackground,
  parseTabs,
  rewindTab,
  sectionPath,
  stepTab,
  tabPathFor,
  visitInTab,
  TAB_HISTORY_LIMIT,
} from './tabs-model';

const plan = newTab('a', '/d1/files/plan');
const pricing = newTab('b', '/d1/files/pricing');
const ops = newTab('c', '/d1/messages/ops');

describe('tabPathFor() (IMC-1.5)', () => {
  test('pages, settings and account screens are tabs', () => {
    assert({
      given: 'a page, a channel, a drive tool, drive settings and an account screen',
      should: 'treat each as a tab at its path',
      actual: ['/d1/files/plan', '/d1/messages/ops', '/d1/calendar', '/d1/settings/general', '/account/display'].map((path) =>
        tabPathFor(stageFor(path), path),
      ),
      expected: ['/d1/files/plan', '/d1/messages/ops', '/d1/calendar', '/d1/settings/general', '/account/display'],
    });
  });

  test('an index or the chat is not a tab', () => {
    assert({
      given: 'the drive chat and a section index',
      should: 'open no tab: nothing is in the middle but Imago',
      actual: ['/d1', '/d1/files', '/d1/messages'].map((path) => tabPathFor(stageFor(path), path)),
      expected: [null, null, null],
    });
  });
});

describe('navigateTabs()', () => {
  const strip = { tabs: [plan, pricing], active: plan.id };

  test('a navigation loads into the active tab', () => {
    assert({
      given: 'Q4 Launch Plan active and another page opened',
      should: 'load it into the active tab, remembering the page it left for Back',
      actual: navigateTabs(strip, ops.path, 'new'),
      expected: { tabs: [{ ...plan, path: ops.path, back: [plan.path] }, pricing], active: plan.id },
    });
  });

  test('a page open in another tab', () => {
    assert({
      given: 'a navigation to a page another tab shows',
      should: 'still load into the active tab, as a browser does',
      actual: navigateTabs(strip, pricing.path, 'new').tabs.map((tab) => tab.path),
      expected: [pricing.path, pricing.path],
    });
  });

  test('the active tab again', () => {
    assert({
      given: 'a navigation to where the active tab already is',
      should: 'return the same strip',
      actual: navigateTabs(strip, plan.path, 'new') === strip,
      expected: true,
    });
  });

  test('no active tab, the page has a tab', () => {
    assert({
      given: 'a first load on a page a stored tab shows',
      should: 'make that tab active instead of opening another',
      actual: navigateTabs({ tabs: [plan, pricing], active: null }, pricing.path, 'new'),
      expected: { tabs: [plan, pricing], active: pricing.id },
    });
  });

  test('no active tab, a new page', () => {
    assert({
      given: 'tabs but none active and a page none of them shows',
      should: 'open it as a new tab after the last one',
      actual: navigateTabs({ tabs: [plan, pricing], active: null }, ops.path, 'new'),
      expected: { tabs: [plan, pricing, newTab('new', ops.path)], active: 'new' },
    });
  });

  test('New tab asked for', () => {
    assert({
      given: 'a navigation that asked for a new tab',
      should: 'insert it beside the active tab and activate it',
      actual: navigateTabs(strip, ops.path, 'new', true),
      expected: { tabs: [plan, newTab('new', ops.path), pricing], active: 'new' },
    });
  });
});

describe('openTabInBackground()', () => {
  test('opens beside the active tab without leaving it', () => {
    assert({
      given: 'a ⌘-clicked page with Q4 Launch Plan active',
      should: 'insert it after the active tab and keep the active one',
      actual: openTabInBackground({ tabs: [plan, pricing], active: plan.id }, ops.path, 'new'),
      expected: { tabs: [plan, newTab('new', ops.path), pricing], active: plan.id },
    });
  });
});

describe('per-tab history', () => {
  const visited = visitInTab(visitInTab(plan, pricing.path), ops.path);

  test('each step is remembered in the tab', () => {
    assert({
      given: 'a tab that went plan → pricing → ops',
      should: 'hold plan and pricing on its Back list',
      actual: [visited.path, visited.back, visited.forward],
      expected: [ops.path, [plan.path, pricing.path], []],
    });
  });

  test('Back then Forward', () => {
    const back = stepTab(visited, 'back');
    assert({
      given: 'one step Back then one Forward',
      should: 'return to each place in turn',
      actual: [back?.path, back?.forward, back === null ? null : stepTab(back, 'forward')?.path],
      expected: [pricing.path, [ops.path], ops.path],
    });
  });

  test('a new step after Back drops Forward', () => {
    const back = stepTab(visited, 'back');
    assert({
      given: 'Back, then another page opened',
      should: 'drop the Forward list, as a browser does',
      actual: back === null ? null : visitInTab(back, '/d1/files/other').forward,
      expected: [],
    });
  });

  test('nowhere to go', () => {
    assert({
      given: 'a fresh tab',
      should: 'have no Back or Forward',
      actual: [stepTab(plan, 'back'), stepTab(plan, 'forward')],
      expected: [null, null],
    });
  });

  test('history is capped', () => {
    const long = Array.from({ length: TAB_HISTORY_LIMIT + 5 }, (_, index) => `/d1/files/p${index}`).reduce(visitInTab, plan);
    assert({
      given: 'more steps than the limit',
      should: 'keep only the most recent ones',
      actual: [long.back.length, long.back.at(-1)],
      expected: [TAB_HISTORY_LIMIT, `/d1/files/p${TAB_HISTORY_LIMIT + 3}`],
    });
  });
});

describe('rewindTab()', () => {
  const visited = visitInTab(visitInTab(plan, pricing.path), ops.path);

  test('the browser’s Back, two steps', () => {
    assert({
      given: 'the browser landing on a place two steps back',
      should: 'move the tab there, keeping the rest as Forward',
      actual: rewindTab(visited, plan.path),
      expected: { ...plan, path: plan.path, back: [], forward: [pricing.path, ops.path] },
    });
  });

  test('the browser’s Forward', () => {
    const rewound = rewindTab(visited, plan.path);
    assert({
      given: 'the browser going forward again',
      should: 'move the tab forward without adding a step',
      actual: rewound === null ? null : rewindTab(rewound, pricing.path),
      expected: { ...plan, path: pricing.path, back: [plan.path], forward: [ops.path] },
    });
  });

  test('a place not in the tab’s history', () => {
    assert({
      given: 'the browser landing somewhere the tab never was',
      should: 'leave it to an ordinary navigation',
      actual: rewindTab(visited, '/d1/files/elsewhere'),
      expected: null,
    });
  });
});

describe('closeTab()', () => {
  test('closing the active tab moves to its right neighbour', () => {
    assert({
      given: 'three tabs with the first active, and the first closed',
      should: 'drop it and activate the next one',
      actual: closeTab({ tabs: [plan, pricing, ops], active: plan.id }, plan.id),
      expected: { tabs: [pricing, ops], next: pricing },
    });
  });

  test('closing the last tab in the row moves left', () => {
    assert({
      given: 'the rightmost tab active and closed',
      should: 'activate its left neighbour',
      actual: closeTab({ tabs: [plan, pricing, ops], active: ops.id }, ops.id).next,
      expected: pricing,
    });
  });

  test('closing a background tab', () => {
    assert({
      given: 'an inactive tab closed',
      should: 'stay on the active page',
      actual: closeTab({ tabs: [plan, pricing, ops], active: plan.id }, pricing.id).next,
      expected: null,
    });
  });

  test('closing the only tab', () => {
    assert({
      given: 'one tab, active, closed',
      should: 'leave no tab and no page to go to (the middle closes)',
      actual: closeTab({ tabs: [plan], active: plan.id }, plan.id),
      expected: { tabs: [], next: null },
    });
  });
});

describe('sectionPath()', () => {
  test('where Close page goes', () => {
    assert({
      given: 'a page, a channel, a drive tool, a setting and an account screen',
      should: 'go to its section, keeping the tabs',
      actual: ['/d1/files/plan', '/d1/messages/ops', '/d1/calendar', '/d1/settings/general', '/account/display', '/dm/c1'].map(
        (path) => sectionPath(stageFor(path)),
      ),
      expected: ['/d1/files', '/d1/messages', '/d1', '/d1', '/', '/dm'],
    });
  });
});

describe('parseTabs()', () => {
  test('stored tabs', () => {
    const visited = visitInTab(plan, pricing.path);
    assert({
      given: 'a stored list with a bad entry',
      should: 'keep only well-formed imago paths, with their history',
      actual: parseTabs(JSON.stringify([visited, { path: 'https://evil' }, { nope: 1 }, ops])),
      expected: [visited, ops],
    });
  });

  test('tabs stored before ids and history', () => {
    assert({
      given: 'the old stored shape, path only, and a repeated id',
      should: 'give each tab a unique id and an empty history',
      actual: parseTabs(JSON.stringify([{ path: plan.path }, { id: 'x', path: pricing.path }, { id: 'x', path: ops.path }])),
      expected: [newTab('stored-0', plan.path), newTab('x', pricing.path), newTab('stored-2', ops.path)],
    });
  });

  test('nothing stored or garbage', () => {
    assert({
      given: 'nothing, and text that is not JSON',
      should: 'start with no tabs',
      actual: [parseTabs(null), parseTabs('{')],
      expected: [[], []],
    });
  });
});

describe('isNewTabClick()', () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  test('the browser new-tab gestures', () => {
    assert({
      given: 'a plain click, ⌘-click, Ctrl-click, middle-click and ⇧⌘-click',
      should: 'treat only ⌘/Ctrl-click and middle-click as new tab',
      actual: [
        click,
        { ...click, metaKey: true },
        { ...click, ctrlKey: true },
        { ...click, button: 1 },
        { ...click, metaKey: true, shiftKey: true },
      ].map(isNewTabClick),
      expected: [false, true, true, true, false],
    });
  });
});

describe('imagoPathOf()', () => {
  test('links inside imago', () => {
    const origin = 'http://localhost:3006';
    assert({
      given: 'an imago link, the imago root, a classic link and another origin',
      should: 'give the basePath-relative path for imago links only',
      actual: [
        imagoPathOf('/imago/d1/files/plan', origin, '/imago'),
        imagoPathOf('/imago', origin, '/imago'),
        imagoPathOf('/dashboard', origin, '/imago'),
        imagoPathOf('https://example.com/imago/d1', origin, '/imago'),
      ],
      expected: ['/d1/files/plan', '/', null, null],
    });
  });
});
