import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../../store/state';
import { tabsPlugin } from './tabs-plugin';

const { syncTabs, setTabs, openBackgroundTab, setNewTabPending, stepBack, stepForward } = tabsPlugin.transactions;
const plan = { path: '/d1/files/plan' };
const stored = JSON.stringify([{ path: '/d1/files/pricing' }]);

describe('tabsPlugin (IMC-1.5)', () => {
  test('first navigation in a drive reads its stored tabs', () => {
    const state = syncTabs(createInitialState(), { key: 'imago:tabs:d1', stored, path: plan.path, tab: plan });
    assert({
      given: "a drive's stored tabs and a page opened",
      should: 'restore them and append the page',
      actual: state.resources.openTabs.map((tab) => tab.path),
      expected: ['/d1/files/pricing', '/d1/files/plan'],
    });
  });

  test('later navigations keep the loaded tabs', () => {
    const first = syncTabs(createInitialState(), { key: 'imago:tabs:d1', stored, path: plan.path, tab: plan });
    const next = syncTabs(first, { key: 'imago:tabs:d1', stored: null, path: '/d1/files', tab: null });
    assert({
      given: 'the page closed (the section index, which is not a tab)',
      should: 'keep every tab and record the visit',
      actual: [next.resources.openTabs.length, next.resources.tabHistory?.current],
      expected: [2, '/d1/files'],
    });
  });

  test('another drive', () => {
    const first = syncTabs(createInitialState(), { key: 'imago:tabs:d1', stored, path: plan.path, tab: plan });
    const other = syncTabs(first, { key: 'imago:tabs:d2', stored: null, path: '/d2/files/x', tab: { path: '/d2/files/x' } });
    assert({
      given: 'a second drive with nothing stored',
      should: 'show only that drive’s tabs',
      actual: other.resources.openTabs.map((tab) => tab.path),
      expected: ['/d2/files/x'],
    });
  });

  test('navigating loads into the active tab', () => {
    const first = syncTabs(createInitialState(), { key: 'imago:tabs:d1', stored, path: '/d1/files/pricing', tab: { path: '/d1/files/pricing' } });
    const next = syncTabs(first, { key: 'imago:tabs:d1', stored: null, path: plan.path, tab: plan });
    assert({
      given: 'a stored tab open and another page opened from it',
      should: 'replace the active tab rather than open a new one',
      actual: [next.resources.openTabs.map((tab) => tab.path), next.resources.activeTab],
      expected: [['/d1/files/plan'], '/d1/files/plan'],
    });
  });

  test('New tab', () => {
    const first = syncTabs(createInitialState(), { key: 'imago:tabs:d1', stored, path: '/d1/files/pricing', tab: { path: '/d1/files/pricing' } });
    const next = syncTabs(setNewTabPending(first, true), { key: 'imago:tabs:d1', stored: null, path: plan.path, tab: plan });
    assert({
      given: 'New tab asked for, then a page opened',
      should: 'open it as a new tab and clear the request',
      actual: [next.resources.openTabs.map((tab) => tab.path), next.resources.newTabPending],
      expected: [['/d1/files/pricing', '/d1/files/plan'], false],
    });
  });

  test('openBackgroundTab', () => {
    const first = syncTabs(createInitialState(), { key: 'imago:tabs:d1', stored, path: '/d1/files/pricing', tab: { path: '/d1/files/pricing' } });
    const next = openBackgroundTab(first, plan);
    assert({
      given: 'a ⌘-clicked page',
      should: 'add its tab and stay in the active one',
      actual: [next.resources.openTabs.map((tab) => tab.path), next.resources.activeTab],
      expected: [['/d1/files/pricing', '/d1/files/plan'], '/d1/files/pricing'],
    });
  });

  test('setTabs drops a closed active tab', () => {
    const first = syncTabs(createInitialState(), { key: 'imago:tabs:d1', stored, path: '/d1/files/pricing', tab: { path: '/d1/files/pricing' } });
    assert({
      given: 'the active tab closed',
      should: 'leave no active tab, so the next page opens a new one',
      actual: setTabs(first, []).resources.activeTab,
      expected: null,
    });
  });

  test('back and forward', () => {
    const a = syncTabs(createInitialState(), { key: 'k', stored: null, path: '/d1/files/a', tab: { path: '/d1/files/a' } });
    const b = syncTabs(a, { key: 'k', stored: null, path: '/d1/files/b', tab: { path: '/d1/files/b' } });
    const back = stepBack(b, undefined);
    assert({
      given: 'two places visited, then Back, then Forward',
      should: 'move the current place each way',
      actual: [back.resources.tabHistory?.current, stepForward(back, undefined).resources.tabHistory?.current],
      expected: ['/d1/files/a', '/d1/files/b'],
    });
  });

  test('setTabs', () => {
    assert({
      given: 'a closed tab’s remaining list',
      should: 'replace the open tabs',
      actual: setTabs(createInitialState(), [plan]).resources.openTabs,
      expected: [plan],
    });
  });
});
