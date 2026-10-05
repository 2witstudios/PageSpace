// @vitest-environment jsdom
import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The URL is the shell's only input besides the store. Next's router is the
// seam: a navigation is a new pathname with the same layout still mounted.
const navigation = vi.hoisted(() => ({ pathname: '/drive-1' }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}));
// The avatar menu's theme switcher needs the root layout's theme provider;
// its own suites prove it. Here it only has to be in the menu.
vi.mock('@/ui/components/theme-switcher/theme-switcher', () => ({
  ThemeSwitcher: () => h('div', { role: 'radiogroup', 'aria-label': 'Theme' }),
}));

// The messages pane loads through SWR and realtime; its own suite proves it
// against the real hooks. Here it only shows what the shell handed it.
vi.mock('@/ui/messages/messages-pane/messages-pane', () => ({
  MessagesPane: ({
    driveId,
    selectedPageId,
    selectedConversationId,
  }: {
    driveId: string | null;
    selectedPageId: string | null;
    selectedConversationId: string | null;
  }) =>
    h('div', {
      'data-messages-pane': driveId ?? '',
      'data-page': selectedPageId ?? '',
      'data-conversation': selectedConversationId ?? '',
    }),
}));

// The tasks pane loads through SWR; its own suite proves it against the real
// client. Here it only shows what the shell handed it.
vi.mock('@/ui/tasks/tasks-pane/tasks-pane', () => ({
  TasksPane: ({ driveId, selectedPageId }: { driveId: string; selectedPageId: string | null }) =>
    h('div', { 'data-tasks-pane': driveId, 'data-selected': selectedPageId ?? '' }),
}));

const { Shell } = await import('./shell');

let root: Root | null = null;
let container: HTMLElement;

/** Stands in for the route below the shell: it counts its own mounts. */
let routeMounts = 0;
function Route() {
  const [mountId] = useState(() => {
    routeMounts += 1;
    return routeMounts;
  });
  return h('p', { 'data-route': mountId }, 'route');
}

/** What the server listed for the viewer; no SWR provider here, so it is all the shell has. */
const initialDrives = [
  { id: 'drive-2', name: 'Beta', kind: 'STANDARD' as const },
  { id: 'home-1', name: 'Home', kind: 'HOME' as const },
  { id: 'drive-1', name: 'Alpha', kind: 'STANDARD' as const },
];

const render = () =>
  act(() => {
    root?.render(h(Shell, { homeDriveId: 'home-1', initialDrives, children: h(Route) }));
  });

const navigate = (pathname: string) => {
  navigation.pathname = pathname;
  render();
};

const slot = (name: string): HTMLElement => {
  const element = container.querySelector(`[data-slot="${name}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${name} slot`);
  return element;
};

const frame = (): HTMLElement => {
  const element = container.firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error('no shell');
  return element;
};

const click = (selector: string) => {
  const element = container.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`nothing matches ${selector}`);
  act(() => element.click());
};

beforeEach(() => {
  setUiState(createInitialState());
  routeMounts = 0;
  navigation.pathname = '/drive-1';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe('Shell', () => {
  test('one shell across every navigation', () => {
    render();
    const before = ['rail', 'list', 'object', 'chat'].map(slot);
    const shell = frame();
    const route = container.querySelector('[data-route]');
    const visited = [
      '/drive-1/files',
      '/drive-1/files/page-1',
      '/drive-1/messages/channel-1',
      '/drive-1/tasks',
      '/drive-1/settings',
      '/dm/conversation-1',
      '/account',
      '/drive-2',
      '/drive-1',
    ];
    const survived = visited.map((pathname) => {
      navigate(pathname);
      return frame() === shell && ['rail', 'list', 'object', 'chat'].every((name, index) => slot(name) === before[index]);
    });

    assert({
      given: 'navigation through every stage, the user-level routes and a drive switch',
      should: 'keep the same frame, rail, list, object and chat nodes mounted',
      actual: survived,
      expected: visited.map(() => true),
    });

    assert({
      given: 'the route below the shell across those navigations',
      should: 'render it in the object slot, mounted once and never remounted by the shell',
      actual: [slot('object').contains(container.querySelector('[data-route]')), container.querySelector('[data-route]') === route, routeMounts],
      expected: [true, true, 1],
    });
  });

  test('the messages section fills its list', () => {
    render();
    const pane = () => slot('list').querySelector<HTMLElement>('[data-messages-pane]');
    const seen = ['/drive-1/messages', '/drive-1/messages/channel-1', '/dm', '/dm/conversation-1', '/drive-1/files'].map(
      (pathname) => {
        navigate(pathname);
        const found = pane();
        return found === null
          ? null
          : [found.dataset.messagesPane, found.dataset.page, found.dataset.conversation];
      },
    );

    assert({
      given: 'the Messages list, an open channel, the user-level DM list, an open DM, then Files',
      should: 'put the channels and DMs in the list slot with the drive and the open thread, and only in Messages',
      actual: seen,
      expected: [
        ['drive-1', '', ''],
        ['drive-1', 'channel-1', ''],
        ['', '', ''],
        ['', '', 'conversation-1'],
        null,
      ],
    });
  });

  test('the tasks section fills its list', () => {
    render();
    const pane = () => slot('list').querySelector<HTMLElement>('[data-tasks-pane]');
    const seen = ['/drive-1/tasks', '/drive-1/tasks/list-1', '/drive-1/files'].map((pathname) => {
      navigate(pathname);
      const found = pane();
      return found === null ? null : [found.dataset.tasksPane, found.dataset.selected];
    });

    assert({
      given: 'the Tasks list, an open task list, then Files',
      should: 'put the drive’s task lists in the list slot, marking the open one, and only in Tasks',
      actual: seen,
      expected: [['drive-1', ''], ['drive-1', 'list-1'], null],
    });
  });

  test('the stage follows the URL', () => {
    render();
    const chat = [frame().dataset.section, frame().dataset.list, slot('list').hasAttribute('inert')];
    navigate('/drive-1/files/page-1');
    const tree = [frame().dataset.section, frame().dataset.list, slot('list').hasAttribute('inert')];

    assert({
      given: 'the drive chat and then an open page',
      should: 'move the panes from chat alone to tree + object + chat',
      actual: [chat, tree, slot('object').className.endsWith('w-stage-object-tree')],
      expected: [
        ['chat', 'closed', true],
        ['files', 'tree', false],
        true,
      ],
    });
  });

  test('× on the tree collapses its section through the store', () => {
    navigation.pathname = '/drive-1/files/page-1';
    render();
    click('[data-slot="list"] button[aria-label="Hide Files"]');
    const opener = slot('object').querySelector('header [data-leading] button[aria-label="Show Files"]');

    assert({
      given: '× on the files tree beside an open page',
      should: 'record files as collapsed, close the list and put the hamburger in the object header’s leading slot',
      actual: [
        getUiState().resources.collapsedSections,
        frame().dataset.listHidden,
        slot('list').hasAttribute('inert'),
        slot('object').className.endsWith('w-stage-object'),
        opener !== null,
        slot('chat').querySelector('[data-leading]'),
      ],
      expected: [['files'], 'true', true, true, true, null],
    });
  });

  test('the hamburger brings the list back', () => {
    navigation.pathname = '/drive-1/files/page-1';
    render();
    click('[data-slot="list"] button[aria-label="Hide Files"]');
    click('[data-slot="object"] [data-leading] button[aria-label="Show Files"]');

    assert({
      given: 'the hamburger on a collapsed files tree',
      should: 'expand the section, reopen the tree and leave the leading slot empty',
      actual: [
        getUiState().resources.collapsedSections,
        frame().dataset.listHidden,
        slot('list').hasAttribute('inert'),
        slot('object').querySelector('[data-leading]'),
      ],
      expected: [[], 'false', false, null],
    });
  });

  test('a collapsed section stays per section', () => {
    navigation.pathname = '/drive-1/files/page-1';
    render();
    click('[data-slot="list"] button[aria-label="Hide Files"]');
    navigate('/drive-1/tasks/list-1');
    const tasks = [frame().dataset.list, frame().dataset.listHidden];
    navigate('/drive-1/files/page-2');

    assert({
      given: 'files collapsed, then a task list, then another page',
      should: 'show the tasks tree and keep the files tree hidden',
      actual: [tasks, [frame().dataset.list, frame().dataset.listHidden]],
      expected: [
        ['tree', 'false'],
        ['closed', 'true'],
      ],
    });
  });

  test('× on the stage-2 list leaves the section', () => {
    navigation.pathname = '/drive-1/files';
    render();
    const driveClose = container.querySelector('[data-slot="list"] a[aria-label="Close Files"]')?.getAttribute('href');
    navigate('/dm');
    const dmClose = container.querySelector('[data-slot="list"] a[aria-label="Close Messages"]')?.getAttribute('href');

    assert({
      given: 'the wide list in a drive and the driveless messages list',
      should: 'link back to the drive chat, or to the root that resolves the Home drive',
      actual: [driveClose, dmClose, getUiState().resources.collapsedSections],
      expected: ['/drive-1', '/', []],
    });
  });

  test('the chat slot', () => {
    render();
    const roomy = [slot('chat').querySelector('section')?.dataset.density, slot('chat').textContent?.includes('Alpha in context')];
    navigate('/drive-1/files/page-1');

    assert({
      given: 'the drive chat and then an open page',
      should: 'carry the stage’s chat context: roomy over the drive, dense beside the page',
      actual: [roomy, [slot('chat').querySelector('section')?.dataset.density, slot('chat').textContent?.includes('This page in context')]],
      expected: [
        ['roomy', true],
        ['dense', true],
      ],
    });
  });

  test('the rail', () => {
    render();
    const rail = slot('rail');
    const names = [...rail.querySelectorAll('a[aria-label], summary[aria-label]')].map((element) =>
      element.getAttribute('aria-label'),
    );
    const messages = rail.querySelector('a[aria-label^="Messages"]');
    navigate('/drive-1/messages/channel-1');
    const current = rail.querySelector(':scope > ul [aria-current]');

    assert({
      given: 'the shell on a drive chat, then on a channel',
      should: 'fill the rail slot with the drive switcher, the drive’s destinations and the avatar menu, and move aria-current without remounting the link',
      actual: [
        names,
        [...rail.querySelectorAll('button')].some((button) => button.textContent === 'Sign out'),
        current === messages,
        rail.querySelectorAll(':scope > ul [aria-current]').length,
      ],
      expected: [
        ['Switch drive, Alpha', 'Chat', 'Files', 'Messages', 'Tasks', 'More', 'Settings', 'Account menu'],
        true,
        true,
        1,
      ],
    });
  });

  test('the rail reopens a collapsed section', () => {
    navigation.pathname = '/drive-1/files/page-1';
    render();
    click('[data-slot="list"] button[aria-label="Hide Files"]');
    click('[data-slot="rail"] a[aria-label="Files"]');

    assert({
      given: 'the files tree hidden, then Files clicked on the rail',
      should: 'expand the section and slide the tree back beside the page',
      actual: [getUiState().resources.collapsedSections, frame().dataset.list, slot('list').hasAttribute('inert')],
      expected: [[], 'tree', false],
    });
  });

  test('the rail on a user-level stage', () => {
    navigation.pathname = '/account';
    render();

    assert({
      given: 'the account stage, which names no drive',
      should: 'link the rail into the Home drive and mark no section current',
      actual: [
        slot('rail').querySelector('a[aria-label="Settings"]')?.getAttribute('href'),
        slot('rail').querySelector(':scope > ul [aria-current]'),
      ],
      expected: ['/home-1/settings', null],
    });
  });

  test('the drive switcher', () => {
    navigation.pathname = '/drive-1/tasks/list-1';
    render();
    const rows = [...slot('rail').querySelectorAll('ul[aria-label="Drives"] a')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
      link.getAttribute('aria-current'),
    ]);

    assert({
      given: 'a task list open in Alpha, with Beta and Home also listed',
      should: 'list Home first, then the rest by name, each linking to its Tasks, with Alpha current',
      actual: rows,
      expected: [
        ['HHome', '/home-1/tasks', null],
        ['AAlpha', '/drive-1/tasks', 'page'],
        ['BBeta', '/drive-2/tasks', null],
      ],
    });
  });

  test('a drive the viewer cannot open', () => {
    render();
    const shell = frame();
    const rail = slot('rail');
    navigate('/secret-drive/files');
    const notFound = slot('object').querySelector('[data-not-found]');

    assert({
      given: 'an address naming a drive the drive list does not hold',
      should: 'keep the shell and show the not-found object in an open object column, with no list and no route content',
      actual: [
        frame() === shell && slot('rail') === rail,
        notFound?.querySelector('h2')?.textContent,
        notFound?.querySelector('a')?.getAttribute('href'),
        slot('object').hasAttribute('inert'),
        [frame().dataset.list, slot('list').hasAttribute('inert')],
        slot('object').querySelector('[data-route]'),
        slot('object').querySelector('section')?.getAttribute('aria-label'),
      ],
      expected: [true, 'Drive not found', '/home-1', false, ['closed', true], null, 'Not found'],
    });

    assert({
      given: 'the same address',
      should: 'never show a name for that drive on the switcher',
      actual: [
        rail.querySelector('summary[aria-label^="Switch drive"]')?.getAttribute('aria-label'),
        rail.textContent?.includes('secret-drive'),
      ],
      expected: ['Switch drive', false],
    });

    navigate('/drive-1/files');
    assert({
      given: 'a switch back to a drive the viewer can open',
      should: 'close the object column (it keeps its last content until the width transition ends) and show the section again',
      actual: [slot('object').hasAttribute('inert'), frame().dataset.list, slot('list').hasAttribute('inert')],
      expected: [true, 'list', false],
    });
  });

  test('the chat names the open drive', () => {
    render();

    assert({
      given: 'the chat of a drive the list names Alpha',
      should: 'put the drive’s name in the chat context',
      actual: slot('chat').textContent?.includes('Alpha in context'),
      expected: true,
    });
  });
});
