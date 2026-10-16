import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import {
  closeTab,
  goBack,
  goForward,
  imagoPathOf,
  isNewTabClick,
  navigateTabs,
  openTabInBackground,
  parseTabs,
  sectionPath,
  tabFor,
  visit,
  type History,
} from './tabs-model';

const plan = { path: '/d1/files/plan' };
const pricing = { path: '/d1/files/pricing' };
const ops = { path: '/d1/messages/ops' };

describe('tabFor() (IMC-1.5)', () => {
  test('pages, settings and account screens are tabs', () => {
    assert({
      given: 'a page, a channel, a drive tool, drive settings and an account screen',
      should: 'open each as a tab keyed by its path',
      actual: ['/d1/files/plan', '/d1/messages/ops', '/d1/calendar', '/d1/settings/general', '/account/display'].map(
        (path) => tabFor(stageFor(path), path)?.path,
      ),
      expected: ['/d1/files/plan', '/d1/messages/ops', '/d1/calendar', '/d1/settings/general', '/account/display'],
    });
  });

  test('an index or the chat is not a tab', () => {
    assert({
      given: 'the drive chat and a section index',
      should: 'open no tab: nothing is in the middle but Imago',
      actual: ['/d1', '/d1/files', '/d1/messages'].map((path) => tabFor(stageFor(path), path)),
      expected: [null, null, null],
    });
  });
});

describe('navigateTabs()', () => {
  const strip = { tabs: [plan, pricing], active: plan.path };

  test('a navigation loads into the active tab', () => {
    assert({
      given: 'Q4 Launch Plan active and another page opened',
      should: 'replace the active tab in place, as a browser tab does, and keep it active',
      actual: navigateTabs(strip, ops),
      expected: { tabs: [ops, pricing], active: ops.path },
    });
  });

  test('a page that already has a tab', () => {
    assert({
      given: 'a navigation to a page open in another tab',
      should: 'switch to that tab and leave the active one as it was',
      actual: navigateTabs(strip, pricing),
      expected: { tabs: [plan, pricing], active: pricing.path },
    });
  });

  test('the active tab again', () => {
    assert({
      given: 'a navigation to the active tab',
      should: 'return the same strip',
      actual: navigateTabs(strip, plan) === strip,
      expected: true,
    });
  });

  test('no active tab', () => {
    assert({
      given: 'tabs but none active (the viewer was on a section index)',
      should: 'open the page as a new tab after the last one',
      actual: navigateTabs({ tabs: [plan, pricing], active: null }, ops),
      expected: { tabs: [plan, pricing, ops], active: ops.path },
    });
  });

  test('New tab asked for', () => {
    assert({
      given: 'a navigation that asked for a new tab',
      should: 'insert it beside the active tab and activate it',
      actual: navigateTabs(strip, ops, true),
      expected: { tabs: [plan, ops, pricing], active: ops.path },
    });
  });
});

describe('openTabInBackground()', () => {
  test('opens beside the active tab without leaving it', () => {
    assert({
      given: 'a ⌘-clicked page with Q4 Launch Plan active',
      should: 'insert it after the active tab and keep the active one',
      actual: openTabInBackground({ tabs: [plan, pricing], active: plan.path }, ops),
      expected: { tabs: [plan, ops, pricing], active: plan.path },
    });
  });

  test('an open tab stays where it is', () => {
    const strip = { tabs: [plan, pricing], active: plan.path };
    assert({
      given: 'a page that already has a tab',
      should: 'return the same strip',
      actual: openTabInBackground(strip, pricing) === strip,
      expected: true,
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

describe('closeTab()', () => {
  test('closing the active tab moves to its right neighbour', () => {
    assert({
      given: 'three tabs with the first active, and the first closed',
      should: 'drop it and activate the next one',
      actual: closeTab([plan, pricing, ops], plan.path, plan.path),
      expected: { tabs: [pricing, ops], next: pricing.path },
    });
  });

  test('closing the last tab in the row moves left', () => {
    assert({
      given: 'the rightmost tab active and closed',
      should: 'activate its left neighbour',
      actual: closeTab([plan, pricing, ops], ops.path, ops.path).next,
      expected: pricing.path,
    });
  });

  test('closing a background tab', () => {
    assert({
      given: 'an inactive tab closed',
      should: 'stay on the active page',
      actual: closeTab([plan, pricing, ops], pricing.path, plan.path).next,
      expected: null,
    });
  });

  test('closing the only tab', () => {
    assert({
      given: 'one tab, active, closed',
      should: 'leave no tab and no page to go to (the middle closes)',
      actual: closeTab([plan], plan.path, plan.path),
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

describe('back and forward', () => {
  const start: History = { back: [], current: '/d1/files/plan', forward: [] };

  test('a visit pushes the previous place and clears forward', () => {
    assert({
      given: 'a new place visited after going back',
      should: 'remember where it came from and drop the forward trail',
      actual: visit({ ...start, forward: ['/x'] }, '/d1/files/pricing'),
      expected: { back: ['/d1/files/plan'], current: '/d1/files/pricing', forward: [] },
    });
  });

  test('back then forward', () => {
    const there = visit(start, '/d1/files/pricing');
    const back = goBack(there);
    assert({
      given: 'one step back and one forward',
      should: 'return to each place in turn',
      actual: [back?.current, back === null ? null : goForward(back)?.current],
      expected: ['/d1/files/plan', '/d1/files/pricing'],
    });
  });

  test('nowhere to go', () => {
    assert({
      given: 'no history either way',
      should: 'disable both',
      actual: [goBack(start), goForward(start)],
      expected: [null, null],
    });
  });

  test('revisiting the current place', () => {
    assert({
      given: 'the same path again (a re-render)',
      should: 'keep the history unchanged',
      actual: visit(start, start.current) === start,
      expected: true,
    });
  });
});

describe('parseTabs()', () => {
  test('stored tabs', () => {
    assert({
      given: 'a stored list with a bad entry',
      should: 'keep only well-formed imago paths',
      actual: parseTabs(JSON.stringify([plan, { path: 'https://evil' }, { nope: 1 }, pricing])),
      expected: [plan, pricing],
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
