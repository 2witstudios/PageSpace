import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../../store/state';
import type { UiState } from '../../store/state';
import { newTab } from './tabs-model';
import { tabsPlugin, type SyncTabs } from './tabs-plugin';

const { syncTabs, setTabs, activateTab, openBackgroundTab, setNewTabPending, stepBack, stepForward } = tabsPlugin.transactions;
const key = 'imago:tabs:d1';
const stored = JSON.stringify([newTab('p', '/d1/files/pricing')]);
const nav = (path: string | null, extra: Partial<SyncTabs> = {}): SyncTabs => ({ key, stored: null, path, id: `id-${path}`, pop: false, ...extra });
const paths = (state: UiState) => state.resources.openTabs.map((tab) => tab.path);
const first = () => syncTabs(createInitialState(), nav('/d1/files/pricing', { stored }));

describe('tabsPlugin (IMC-1.5)', () => {
  test('first navigation in a drive reads its stored tabs', () => {
    const state = syncTabs(createInitialState(), nav('/d1/files/plan', { stored }));
    assert({
      given: "a drive's stored tabs and a page none of them shows",
      should: 'restore them and open the page as a new active tab',
      actual: [paths(state), state.resources.activeTab],
      expected: [['/d1/files/pricing', '/d1/files/plan'], 'id-/d1/files/plan'],
    });
  });

  test('first navigation onto a stored tab', () => {
    const state = first();
    assert({
      given: 'a reload on a page a stored tab shows',
      should: 'make that tab active, opening nothing',
      actual: [paths(state), state.resources.activeTab],
      expected: [['/d1/files/pricing'], 'p'],
    });
  });

  test('navigating loads into the active tab', () => {
    const next = syncTabs(first(), nav('/d1/files/plan'));
    assert({
      given: 'a stored tab open and another page opened from it',
      should: 'load it into the active tab rather than open a new one',
      actual: [paths(next), next.resources.activeTab, next.resources.openTabs[0]?.back],
      expected: [['/d1/files/plan'], 'p', ['/d1/files/pricing']],
    });
  });

  test('a section index is not a step', () => {
    const next = syncTabs(first(), nav(null));
    assert({
      given: 'the page closed (the section index, which is not a tab)',
      should: 'keep every tab and the active one',
      actual: [paths(next), next.resources.activeTab],
      expected: [['/d1/files/pricing'], 'p'],
    });
  });

  test('another drive', () => {
    const other = syncTabs(first(), nav('/d2/files/x', { key: 'imago:tabs:d2' }));
    assert({
      given: 'a second drive with nothing stored',
      should: 'show only that drive’s tabs',
      actual: paths(other),
      expected: ['/d2/files/x'],
    });
  });

  test('Back and Forward step the active tab', () => {
    const there = syncTabs(first(), nav('/d1/files/plan'));
    const back = stepBack(there, undefined);
    assert({
      given: 'two pages visited in one tab, then Back, then Forward',
      should: 'move that tab each way',
      actual: [paths(back), paths(stepForward(back, undefined))],
      expected: [['/d1/files/pricing'], ['/d1/files/plan']],
    });
  });

  test('Back is per tab', () => {
    const there = syncTabs(first(), nav('/d1/files/plan'));
    const withSecond = syncTabs(setNewTabPending(there, true), nav('/d1/files/notes'));
    assert({
      given: 'a second tab opened with New tab',
      should: 'give it no Back, while the first tab keeps its own',
      actual: withSecond.resources.openTabs.map((tab) => tab.back),
      expected: [['/d1/files/pricing'], []],
    });
  });

  test('the browser’s Back rewinds the active tab', () => {
    const there = syncTabs(first(), nav('/d1/files/plan'));
    const popped = syncTabs(there, nav('/d1/files/pricing', { pop: true }));
    assert({
      given: 'the browser’s Back to the previous page',
      should: 'move the tab back, keeping the page it left as Forward',
      actual: [paths(popped), popped.resources.openTabs[0]?.back, popped.resources.openTabs[0]?.forward],
      expected: [['/d1/files/pricing'], [], ['/d1/files/plan']],
    });
  });

  test('New tab', () => {
    const next = syncTabs(setNewTabPending(first(), true), nav('/d1/files/plan'));
    assert({
      given: 'New tab asked for, then a page opened',
      should: 'open it as a new active tab and clear the request',
      actual: [paths(next), next.resources.activeTab, next.resources.newTabPending],
      expected: [['/d1/files/pricing', '/d1/files/plan'], 'id-/d1/files/plan', false],
    });
  });

  test('openBackgroundTab', () => {
    const next = openBackgroundTab(first(), { path: '/d1/files/plan', id: 'bg' });
    assert({
      given: 'a ⌘-clicked page',
      should: 'add its tab and stay in the active one',
      actual: [paths(next), next.resources.activeTab],
      expected: [['/d1/files/pricing', '/d1/files/plan'], 'p'],
    });
  });

  test('activateTab', () => {
    const withBg = openBackgroundTab(first(), { path: '/d1/files/plan', id: 'bg' });
    assert({
      given: 'a tab clicked, and an id that is not open',
      should: 'make the clicked tab active and ignore the unknown one',
      actual: [activateTab(withBg, 'bg').resources.activeTab, activateTab(withBg, 'gone') === withBg],
      expected: ['bg', true],
    });
  });

  test('setTabs drops a closed active tab', () => {
    assert({
      given: 'the active tab closed',
      should: 'leave no active tab, so the next page opens a new one',
      actual: setTabs(first(), []).resources.activeTab,
      expected: null,
    });
  });
});
