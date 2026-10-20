// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createApiClient } from '@/api/client';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { mount, unmountAll } from '../../test-support/dom';
import { stageFor } from '../stage/stage';
import { tabsStorageKey } from '../tabs/tabs-model';
import { TabSync } from '../tabs/use-open-tabs';

const navigation = vi.hoisted(() => ({ pathname: '/d1/files/plan', pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: (path: string) => navigation.pushed.push(path) }),
}));
vi.mock('@/retained-adapters/retained-provider', () => ({ RetainedSurface: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/retained/components/common/PageViewers', () => ({ PageViewers: () => h('span', { title: 'Dana is here' }, 'DA') }));
vi.mock('@/retained/hooks/usePagePresence', () => ({ usePagePresence: () => {} }));
const trail = vi.hoisted(() => ({ value: [{ id: 'launch', title: 'Launch' }, { id: 'plan', title: 'Q4 Launch Plan' }] as { id: string; title: string }[] | undefined }));
vi.mock('@/ui/tasks/use-tasks/use-tasks', () => ({ usePageTrail: () => ({ trail: trail.value }) }));
const dialogs = vi.hoisted(() => ({ shown: [] as (string | null)[], addChild: 0 }));
vi.mock('@/ui/files/page-head/page-head-dialogs', () => ({
  PageHeadDialogs: ({ dialog }: { dialog: string | null }) => {
    dialogs.shown.push(dialog);
    return null;
  },
  openAddChild: () => {
    dialogs.addChild += 1;
  },
}));
vi.mock('@/ui/files/page-actions/page-actions', () => ({
  PageActionsMenu: ({ trigger, onDialog }: { trigger: ReactNode; onDialog: (dialog: string) => void }) =>
    h('span', null, trigger, h('button', { type: 'button', 'aria-label': 'Rename item', onClick: () => onDialog('rename') }), h('button', { type: 'button', 'aria-label': 'Add child item', onClick: () => onDialog('add-child') })),
}));

const { PhoneDocHead } = await import('./phone-doc-head');

const PAGES: Readonly<Record<string, unknown>> = {
  '/api/pages/plan': { id: 'plan', title: 'Q4 Launch Plan', type: 'DOCUMENT', driveId: 'd1' },
  '/api/pages/pricing': { id: 'pricing', title: 'Pricing Model', type: 'SHEET', driveId: 'd1' },
  '/api/pages/ops': { id: 'ops', title: 'launch-ops', type: 'CHANNEL', driveId: 'd1' },
};

const client = createApiClient({
  fetch: async (input) => Response.json(PAGES[new URL(input, 'http://x').pathname] ?? {}, { status: 200 }),
  navigate: () => {},
  location: () => ({ origin: 'http://localhost:3006', pathname: '/imago/d1' }),
});

const render = () =>
  mount(
    <ImagoSWRProvider client={client}>
      <TabSync driveKey="d1" />
      <PhoneDocHead stage={stageFor(navigation.pathname)} pageId="plan" />
    </ImagoSWRProvider>,
  );

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));
const label = (root: HTMLElement, name: string): HTMLElement | null => root.querySelector(`[aria-label="${name}"]`);
const press = (root: HTMLElement, name: string) => {
  const element = label(root, name);
  if (element === null) throw new Error(`no ${name}`);
  act(() => element.click());
};
const rows = (root: HTMLElement) => [...root.querySelectorAll('[role="dialog"] [data-tab-path]')].map((row) => row.textContent);

beforeEach(() => {
  setUiState(createInitialState());
  window.localStorage.clear();
  window.localStorage.setItem(tabsStorageKey('d1'), JSON.stringify([{ path: '/d1/files/plan' }, { path: '/d1/files/pricing' }, { path: '/d1/messages/ops' }]));
  navigation.pathname = '/d1/files/plan';
  navigation.pushed = [];
  trail.value = [{ id: 'launch', title: 'Launch' }, { id: 'plan', title: 'Q4 Launch Plan' }];
  dialogs.shown = [];
  dialogs.addChild = 0;
});
afterEach(unmountAll);

describe('PhoneDocHead (IMC-11.3)', () => {
  test('Back to Files, the parent over the title, presence, the count and Page actions', async () => {
    const root = render();
    await settle(() => {
      if (label(root, 'Page actions') === null) throw new Error('page not loaded');
    });
    assert({
      given: 'Q4 Launch Plan inside Launch with three open pages',
      should: 'draw the board head',
      actual: [
        label(root, 'Back to Files')?.getAttribute('href'),
        root.querySelector('header')?.textContent?.startsWith('LaunchQ4 Launch Plan'),
        root.querySelector('[title="Dana is here"]')?.textContent,
        label(root, '3 open pages')?.textContent,
        root.querySelector('[role="dialog"]'),
      ],
      expected: ['/d1/files', true, 'DA', '3', null],
    });
  });

  test('the count opens the sheet, one tab closes and the page stays', async () => {
    const root = render();
    await settle(() => {
      if (label(root, 'Page actions') === null) throw new Error('page not loaded');
    });
    press(root, '3 open pages');
    await settle(() => {
      if (rows(root).includes('Loading…') || rows(root).length !== 3) throw new Error('rows not loaded');
    });
    assert({
      given: 'the count pressed',
      should: 'open "Open pages" with a row per tab, Close all and a Close control each',
      actual: [rows(root), label(root, 'Open pages')?.getAttribute('role'), label(root, 'Close Pricing Model') !== null, label(root, 'Close open pages') !== null],
      expected: [['Q4 Launch Plan', 'Pricing Model', '#launch-ops'], 'dialog', true, true],
    });
    press(root, 'Close Pricing Model');
    assert({
      given: 'a background tab closed',
      should: 'drop its row and not navigate',
      actual: [rows(root), navigation.pushed],
      expected: [['Q4 Launch Plan', '#launch-ops'], []],
    });
    press(root, 'Close Q4 Launch Plan');
    assert({
      given: 'the open page closed',
      should: 'move to the neighbour',
      actual: navigation.pushed,
      expected: ['/d1/messages/ops'],
    });
  });

  test('Close all leaves the empty line and the scrim dismisses the sheet', async () => {
    const root = render();
    await settle(() => {
      if (label(root, 'Page actions') === null) throw new Error('page not loaded');
    });
    press(root, '3 open pages');
    act(() => [...root.querySelectorAll('button')].find((button) => button.textContent === 'Close all')?.click());
    assert({
      given: 'Close all',
      should: 'show the empty line, count 0 and stay on the page',
      actual: [root.querySelector('[role="dialog"] p')?.textContent, label(root, '0 open pages') !== null, navigation.pushed],
      expected: ['No open pages — pick one in Files or ask Imago.', true, []],
    });
    press(root, 'Close open pages');
    assert({ given: 'the scrim pressed', should: 'close the sheet', actual: root.querySelector('[role="dialog"]'), expected: null });
  });

  test('closing the last tab keeps the page in view with the empty line', async () => {
    window.localStorage.setItem(tabsStorageKey('d1'), JSON.stringify([{ path: '/d1/files/plan' }]));
    const root = render();
    await settle(() => {
      if (label(root, 'Page actions') === null) throw new Error('page not loaded');
    });
    press(root, '1 open pages');
    await settle(() => {
      if (label(root, 'Close Q4 Launch Plan') === null) throw new Error('rows not loaded');
    });
    press(root, 'Close Q4 Launch Plan');
    assert({
      given: 'the only tab closed from the sheet',
      should: 'stay put and say no pages are open',
      actual: [navigation.pushed, root.querySelector('[role="dialog"] p')?.textContent],
      expected: [[], 'No open pages — pick one in Files or ask Imago.'],
    });
  });

  test('Page actions items open their dialogs', async () => {
    const root = render();
    await settle(() => {
      if (label(root, 'Page actions') === null) throw new Error('page not loaded');
    });
    press(root, 'Rename item');
    press(root, 'Add child item');
    assert({
      given: 'Rename and Add child chosen',
      should: 'open the rename dialog and the add-child flow',
      actual: [dialogs.shown.at(-1) ?? dialogs.shown, dialogs.addChild],
      expected: ['rename', 1],
    });
  });

  test('a page with no folder and a stale trail', () => {
    trail.value = undefined;
    const root = render();
    assert({
      given: 'no trail and the page not loaded',
      should: 'draw an untitled head with no parent and no Page actions',
      actual: [root.querySelector('header')?.textContent, label(root, 'Page actions')],
      expected: ['3', null],
    });
  });

  test('a top-level page names no parent', async () => {
    trail.value = [{ id: 'plan', title: 'Q4 Launch Plan' }];
    const root = render();
    await settle(() => {
      if (label(root, 'Page actions') === null) throw new Error('page not loaded');
    });
    assert({
      given: 'a trail of one',
      should: 'show the title alone',
      actual: root.querySelector('header')?.textContent?.startsWith('Q4 Launch PlanDA3'),
      expected: true,
    });
  });
});
