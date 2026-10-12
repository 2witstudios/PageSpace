import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import {
  closeTab,
  goBack,
  goForward,
  openTab,
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

describe('openTab()', () => {
  test('appends a new tab', () => {
    assert({
      given: 'the canon tabs and a fourth page',
      should: 'append it after the last tab',
      actual: openTab([plan, pricing], ops).map((tab) => tab.path),
      expected: ['/d1/files/plan', '/d1/files/pricing', '/d1/messages/ops'],
    });
  });

  test('an open tab stays where it is', () => {
    const tabs = [plan, pricing];
    assert({
      given: 'a page that already has a tab',
      should: 'return the same list',
      actual: openTab(tabs, plan) === tabs,
      expected: true,
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
