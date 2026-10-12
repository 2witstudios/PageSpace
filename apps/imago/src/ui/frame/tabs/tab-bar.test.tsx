// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createApiClient } from '@/api/client';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { mount, unmountAll } from '../../test-support/dom';
import { stageFor } from '../stage/stage';
import { TabBar } from './tab-bar';
import { tabsStorageKey } from './tabs-model';

const navigation = vi.hoisted(() => ({ pathname: '/d1/files/plan', pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: (path: string) => navigation.pushed.push(path) }),
}));

const PAGES: Readonly<Record<string, unknown>> = {
  '/api/pages/plan': { id: 'plan', title: 'Q4 Launch Plan', type: 'DOCUMENT' },
  '/api/pages/pricing': { id: 'pricing', title: 'Pricing Model', type: 'SHEET' },
  '/api/pages/ops': { id: 'ops', title: 'launch-ops', type: 'CHANNEL' },
};

const client = createApiClient({
  fetch: async (input) => Response.json(PAGES[new URL(input, 'http://x').pathname] ?? {}, { status: 200 }),
  navigate: () => {},
  location: () => ({ origin: 'http://localhost:3006', pathname: '/imago/d1' }),
});

const render = () =>
  mount(
    <ImagoSWRProvider client={client}>
      <TabBar stage={stageFor(navigation.pathname)} driveKey="d1" />
    </ImagoSWRProvider>,
  );

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));
const tabs = (root: HTMLElement) => [...root.querySelectorAll('[role="tab"]')];
const titles = (root: HTMLElement) => tabs(root).map((tab) => tab.textContent);

beforeEach(() => {
  setUiState(createInitialState());
  window.localStorage.clear();
  window.localStorage.setItem(tabsStorageKey('d1'), JSON.stringify([{ path: '/d1/files/plan' }, { path: '/d1/files/pricing' }, { path: '/d1/messages/ops' }]));
  navigation.pathname = '/d1/files/plan';
  navigation.pushed = [];
});
afterEach(unmountAll);

describe('TabBar (IMC-1.5)', () => {
  test('the canon tabs', async () => {
    const root = render();
    await settle(() => {
      if (!titles(root).includes('#launch-ops')) throw new Error('labels not loaded');
    });
    assert({
      given: 'three stored tabs with Q4 Launch Plan open',
      should: 'list them in order with the open page selected and channels written #name',
      actual: [titles(root), tabs(root).map((tab) => tab.getAttribute('aria-selected'))],
      expected: [['Q4 Launch Plan', 'Pricing Model', '#launch-ops'], ['true', 'false', 'false']],
    });
  });

  test('closing the active tab moves to its neighbour', async () => {
    const root = render();
    await settle(() => {
      if (tabs(root).length !== 3) throw new Error('tabs not loaded');
    });
    act(() => root.querySelector<HTMLButtonElement>('[aria-label="Close Q4 Launch Plan"]')?.click());
    assert({
      given: 'Close Q4 Launch Plan on the active tab',
      should: 'drop it and open Pricing Model',
      actual: [tabs(root).length, navigation.pushed],
      expected: [2, ['/d1/files/pricing']],
    });
  });

  test('closing the last tab closes the middle', async () => {
    window.localStorage.setItem(tabsStorageKey('d1'), JSON.stringify([{ path: '/d1/files/plan' }]));
    const root = render();
    await settle(() => {
      if (tabs(root).length !== 1) throw new Error('tab not loaded');
    });
    act(() => root.querySelector<HTMLButtonElement>('[aria-label="Close Q4 Launch Plan"]')?.click());
    assert({
      given: 'the only tab closed',
      should: 'leave no tab and go to the Files section, where Imago is the ground',
      actual: [tabs(root).length, navigation.pushed],
      expected: [0, ['/d1/files']],
    });
  });

  test('Back and Forward start disabled', () => {
    const root = render();
    assert({
      given: 'the first place visited',
      should: 'disable Back and Forward',
      actual: ['Back', 'Forward'].map((name) => root.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)?.disabled),
      expected: [true, true],
    });
  });

  test('tabs persist under imago’s own key', async () => {
    navigation.pathname = '/d1/calendar';
    render();
    await settle(() => {
      if (!window.localStorage.getItem(tabsStorageKey('d1'))?.includes('calendar')) throw new Error('not saved');
    });
    assert({
      given: 'a drive tool opened',
      should: 'append it to the stored tabs, never touching classic’s tabs-storage',
      actual: [JSON.parse(window.localStorage.getItem(tabsStorageKey('d1')) ?? '[]').length, window.localStorage.getItem('tabs-storage')],
      expected: [4, null],
    });
  });
});
