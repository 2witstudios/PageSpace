// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { mount, unmountAll } from '../../test-support/dom';
import { stageFor } from '../stage/stage';
import { newTab } from '../tabs/tabs-model';
import { ClosePage } from './controls';

const navigation = vi.hoisted(() => ({ pathname: '/d1/files/plan', pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: (path: string) => navigation.pushed.push(path), prefetch: () => {} }),
}));

const seed = (tabs: readonly ReturnType<typeof newTab>[], active: string) => {
  const state = createInitialState();
  setUiState({ ...state, resources: { ...state.resources, openTabs: tabs, activeTab: active, tabsKey: 'imago:tabs:d1', imagoClosed: true } });
};

const close = () => {
  const root = mount(<ClosePage stage={stageFor(navigation.pathname)} />);
  const link = root.querySelector<HTMLAnchorElement>('a[aria-label="Close page"]');
  act(() => link?.click());
  return link?.getAttribute('href');
};

beforeEach(() => {
  navigation.pathname = '/d1/files/plan';
  navigation.pushed = [];
});
afterEach(unmountAll);

describe('ClosePage', () => {
  test('closes the page’s tab', () => {
    seed([newTab('a', '/d1/files/plan'), newTab('b', '/d1/files/pricing')], 'a');
    const href = close();
    const { openTabs, activeTab, imagoClosed } = getUiState().resources;
    assert({
      given: 'Close page on a page whose tab has a neighbour',
      should: 'close the tab, as its × does, move to the neighbour and reopen Imago',
      actual: [href, openTabs.map((tab) => tab.id), activeTab, navigation.pushed, imagoClosed],
      expected: ['/d1/files', ['b'], 'b', ['/d1/files/pricing'], false],
    });
  });

  test('the last tab', () => {
    seed([newTab('a', '/d1/files/plan')], 'a');
    close();
    assert({
      given: 'Close page on the only tab',
      should: 'close it and go to the page’s section',
      actual: [getUiState().resources.openTabs, navigation.pushed],
      expected: [[], ['/d1/files']],
    });
  });
});
