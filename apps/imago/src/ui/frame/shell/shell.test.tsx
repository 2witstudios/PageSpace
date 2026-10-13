// @vitest-environment jsdom
import { act, createElement as h, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import type { Stage } from '../stage/stage';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { fakeRealtime } from '../../test-support/fake-realtime';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The URL is the shell's only input besides the store. Next's router is the
// seam: a navigation is a new pathname with the same layout still mounted.
const navigation = vi.hoisted(() => ({ pathname: '/drive-1' as string | null }));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  // The palette navigates through the router; its own suite proves where.
  useRouter: () => ({ push: () => {} }),
}));
// The avatar menu's theme switcher needs the root layout's theme provider;
// its own suites prove it. Here it only has to be in the menu.
vi.mock('@/ui/components/theme-switcher/theme-switcher', () => ({
  ThemeSwitcher: () => h('div', { role: 'radiogroup', 'aria-label': 'Theme' }),
}));

// The drive switcher is apps/web's dialog on the retained stores; its own suite
// (and the brand chip's) proves it. Here it only has to open from the tile.
vi.mock('@/retained/components/layout/navbar/DriveSwitcherDialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? h('div', { role: 'dialog', 'aria-label': 'Switch drive' }) : null),
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

// The DM index pane loads through SWR and realtime too; its own suite proves
// it against the real hooks. Here it shows the open conversation it was handed.
vi.mock('@/ui/messages/dm-index/dm-index', () => ({
  DmIndexPane: ({ selectedConversationId }: { selectedConversationId: string | null }) =>
    h('div', { 'data-dm-pane': '', 'data-conversation': selectedConversationId ?? '' }),
}));

// The tasks pane loads through SWR; its own suite proves it against the real
// client. Here it only shows what the shell handed it.
vi.mock('@/ui/tasks/tasks-pane/tasks-pane', () => ({
  TasksPane: ({ driveId, selectedPageId }: { driveId: string; selectedPageId: string | null }) =>
    h('div', { 'data-tasks-pane': driveId, 'data-selected': selectedPageId ?? '' }),
}));

// The files pane loads its tree through SWR and realtime; its own suite
// proves it against the real hooks. Here it draws the real list pane (so
// Close sidebar behaves as in the app) around what the shell handed it.
vi.mock('@/ui/files/files-pane/files-pane', async () => {
  const { ListPane } = await import('@/ui/frame/list-pane/list-pane');
  return {
    FilesPane: ({
      driveId,
      selectedPageId,
      variant,
      title,
    }: {
      driveId: string;
      selectedPageId: string | null;
      variant: 'list' | 'tree';
      title: string;
    }) =>
      h(
        ListPane,
        { section: 'files', variant, title },
        h('div', { 'data-files-pane': driveId, 'data-selected': selectedPageId ?? '' }),
      ),
  };
});

// The chat pane loads agents, conversations and turns through SWR; its own
// suite proves it against the real hooks. Here it shows what the shell handed
// it (the head's leading and trailing controls), the context the stage gives
// it, and how often it mounted.
const chatMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/ui/chat/chat-pane/chat-pane', async () => {
  const { useState } = await import('react');
  const { chatContextFor } = await import('../stage/stage');
  const { renderPaneHeader } = await import('../pane/pane-header');
  return {
    ChatPane: ({
      stage,
      driveName,
      homeDriveId,
      leading,
      trailing,
    }: {
      stage: Stage;
      driveName?: string;
      homeDriveId: string | null;
      leading?: ReactNode;
      trailing?: ReactNode;
    }) => {
      useState(() => {
        chatMounts.count += 1;
        return chatMounts.count;
      });
      const context = chatContextFor(stage, driveName === undefined ? {} : { drive: driveName });
      return h(
        'aside',
        { 'aria-label': 'Imago', 'data-density': context.density, 'data-drive': stage.driveId ?? '', 'data-home': homeDriveId ?? '' },
        renderPaneHeader({ title: 'Imago', leading, actions: trailing }),
        context.contextLabel,
      );
    },
  };
});

// The page head loads the page, its trail and classic's share and presence; its own suite
// proves them. Here it only has to carry the shell's Show sidebar, Ask and Close page.
vi.mock('@/ui/files/page-head/page-head', async () => {
  const { renderPaneHeader } = await import('../pane/pane-header');
  return {
    PageHead: ({ pageId, leading, trailing }: { pageId: string; leading?: ReactNode; trailing?: ReactNode }) =>
      renderPaneHeader({ title: `page ${pageId}`, leading, actions: trailing }),
  };
});

// The chat history loads through SWR; its own suite proves it beside the real
// chat pane. Here it only has to be in the list slot, with its Close sidebar
// wired to the store as the real one is.
const historyMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/ui/chat/chat-history/chat-history', async () => {
  const { useState } = await import('react');
  const { dispatch, transactions } = await import('../../store/transactions');
  return {
    ChatHistory: () => {
      useState(() => {
        historyMounts.count += 1;
        return historyMounts.count;
      });
      return h(
        'section',
        { 'aria-label': 'Chat history' },
        h('button', { type: 'button', 'aria-label': 'Close sidebar', onClick: () => dispatch(transactions.collapseSection, 'chat') }),
      );
    },
  };
});

// A drive tool's pane loads its own data; its suites prove it. Here it only has to be in the list slot.
vi.mock('@/ui/frame/tool-pane/tool-pane', () => ({
  ToolPane: ({ tool, driveId }: { tool: string; driveId: string }) => h('div', { 'data-tool-pane': `${tool}:${driveId}` }),
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

/** The rail's live badge count listens on the tab's realtime connection. */
const realtime = fakeRealtime();

const render = (homeDriveId: string | null = 'home-1') =>
  act(() => {
    root?.render(
      h(RealtimeProvider, {
        client: realtime.client,
        children: h(Shell, { homeDriveId, initialDrives, children: h(Route) }),
      }),
    );
  });

const navigate = (pathname: string, homeDriveId: string | null = 'home-1') => {
  navigation.pathname = pathname;
  render(homeDriveId);
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
  chatMounts.count = 0;
  historyMounts.count = 0;
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
  test('a drive tool fills the list with its pane and names the object for the tool', () => {
    navigate('/drive-1/members');
    assert({
      given: 'a drive tool address',
      should: 'mount that tool pane for the drive and title the object column with the tool',
      actual: [
        slot('list').querySelector<HTMLElement>('[data-tool-pane]')?.dataset.toolPane,
        slot('object').querySelector('section')?.getAttribute('aria-label') ?? container.querySelector('section[aria-label="Members"]')?.getAttribute('aria-label'),
      ],
      expected: ['members:drive-1', 'Members'],
    });
  });

  test('screens that open Imago folded fold it on entry', () => {
    render();
    navigate('/drive-1/calendar');
    assert({
      given: 'entering a folded screen',
      should: 'collapse Imago in the store',
      actual: getUiState().resources.imagoCollapsed,
      expected: true,
    });
  });

  test('without a Home drive the not-found page offers no way home, and the account stage still renders', () => {
    render(null);
    navigate('/drive-9', null);
    const missingHome = container.querySelector('a[href="/null"]');
    navigate('/account', null);
    assert({
      given: 'a viewer with no Home drive on an unknown drive, then on the account',
      should: 'link nowhere and keep the shell mounted',
      actual: [missingHome, slot('list').querySelector('nav')?.getAttribute('aria-label')],
      expected: [null, 'Account'],
    });
  });

  test('a missing pathname is read as the root', () => {
    navigation.pathname = null;
    render();
    assert({ given: 'no pathname from the router', should: 'still render the shell', actual: container.firstElementChild !== null, expected: true });
  });

  test('one shell across every navigation', () => {
    render();
    const before = ['rail', 'stage', 'list', 'object', 'chat', 'empty'].map(slot);
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
      return (
        frame() === shell &&
        ['rail', 'stage', 'list', 'object', 'chat', 'empty'].every((name, index) => slot(name) === before[index])
      );
    });

    assert({
      given: 'navigation through every stage, the user-level routes and a drive switch',
      should: 'keep the same frame, rail, stage sheet, list, page, Imago and empty-middle nodes mounted',
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
    const pane = () => slot('list').querySelector<HTMLElement>('[data-messages-pane], [data-dm-pane]');
    const seen = ['/drive-1/messages', '/drive-1/messages/channel-1', '/dm', '/dm/conversation-1', '/drive-1/files'].map(
      (pathname) => {
        navigate(pathname);
        const found = pane();
        return found === null
          ? null
          : [found.dataset.messagesPane ?? 'dm', found.dataset.page ?? '', found.dataset.conversation ?? ''];
      },
    );

    assert({
      given: 'the Messages list, an open channel, the user-level DM index, an open DM, then Files',
      should: 'put the channels in the list slot with the drive and open thread, the DM index for /dm, and nothing in Files',
      actual: seen,
      expected: [
        ['drive-1', '', ''],
        ['drive-1', 'channel-1', ''],
        ['dm', '', ''],
        ['dm', '', 'conversation-1'],
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

  test('the files section fills its list', () => {
    render();
    const pane = () => slot('list').querySelector<HTMLElement>('[data-files-pane]');
    const seen = ['/drive-1/files', '/drive-1/files/page-1', '/drive-1/tasks'].map((pathname) => {
      navigate(pathname);
      const found = pane();
      return found === null ? null : [found.dataset.filesPane, found.dataset.selected];
    });

    assert({
      given: 'the Files list, an open page, then Tasks',
      should: 'put the drive’s page tree in the list slot, marking the open page, and only in Files',
      actual: seen,
      expected: [['drive-1', ''], ['drive-1', 'page-1'], null],
    });
  });

  test('the stage follows the URL', () => {
    render();
    const chat = [frame().dataset.section, frame().dataset.list, frame().dataset.imago, slot('list').hasAttribute('inert')];
    navigate('/drive-1/files/page-1');
    const tree = [frame().dataset.section, frame().dataset.list, frame().dataset.imago, slot('list').hasAttribute('inert')];

    assert({
      given: 'the drive chat and then an open page',
      should: 'move the panes from history + Imago on the ground to tree + page + Imago docked',
      actual: [chat, tree, slot('object').classList.contains('flex-1'), slot('chat').classList.contains('w-chat-pane')],
      expected: [
        ['chat', 'list', 'ground', false],
        ['files', 'tree', 'docked', false],
        true,
        true,
      ],
    });
  });

  test('the chat section fills its list with the history', () => {
    render();
    const history = () => slot('list').querySelector('section[aria-label="Chat history"]');
    const onChat = history() !== null;
    navigate('/drive-1/files');
    const onFiles = history() !== null;
    navigate('/drive-2');

    assert({
      given: 'the drive chat, then Files, then another drive’s chat',
      should: 'hold the chat history in the list slot on the chat stages only',
      actual: [onChat, onFiles, history() !== null, slot('list').hasAttribute('inert')],
      expected: [true, false, true, false],
    });
  });

  test('switching chats remounts nothing', () => {
    render();
    const before = ['rail', 'list', 'object', 'chat'].map(slot);
    const shell = frame();
    const history = slot('list').querySelector('section[aria-label="Chat history"]');
    act(() => dispatch(transactions.openConversation, 'c1'));
    act(() => dispatch(transactions.startNewChat, undefined));
    act(() => dispatch(transactions.openConversation, 'c2'));

    assert({
      given: 'a past chat picked, then New chat, then another past chat',
      should: 'keep the frame, rail, list, object and chat nodes, the history and the chat pane each mounted once',
      actual: [
        frame() === shell && ['rail', 'list', 'object', 'chat'].every((name, index) => slot(name) === before[index]),
        slot('list').querySelector('section[aria-label="Chat history"]') === history,
        chatMounts.count,
        historyMounts.count,
      ],
      expected: [true, true, 1, 1],
    });
  });

  test('× on the chat history hides it, and the rail brings it back', () => {
    render();
    click('[data-slot="list"] button[aria-label="Close sidebar"]');
    const hidden = [getUiState().resources.collapsedSections, frame().dataset.list, frame().dataset.listHidden, slot('list').hasAttribute('inert')];
    navigate('/drive-1/files/page-1');
    const files = frame().dataset.list;
    navigate('/drive-1');
    click('[data-slot="rail"] a[aria-label="Chat"]');

    assert({
      given: 'the history hidden, a visit to an open page, then Chat clicked on the rail',
      should: 'hide only the chat’s list (the files tree stays), then slide the history back',
      actual: [hidden, files, getUiState().resources.collapsedSections, frame().dataset.list, slot('list').hasAttribute('inert')],
      expected: [[['chat'], 'closed', 'true', true], 'tree', [], 'list', false],
    });
  });

  test('Close sidebar on the tree collapses its section through the store', () => {
    navigation.pathname = '/drive-1/files/page-1';
    render();
    click('[data-slot="list"] button[aria-label="Close sidebar"]');
    const opener = slot('object').querySelector('header [data-leading] button[aria-label="Show sidebar"]');

    assert({
      given: 'Close sidebar on the files tree beside an open page',
      should: 'record files as collapsed, close the pane and put Show sidebar in the page head, not Imago’s',
      actual: [
        getUiState().resources.collapsedSections,
        frame().dataset.listHidden,
        slot('list').hasAttribute('inert'),
        slot('list').classList.contains('w-0'),
        opener !== null,
        slot('chat').querySelector('[data-leading]'),
      ],
      expected: [['files'], 'true', true, true, true, null],
    });
  });

  test('Show sidebar brings the pane back', () => {
    navigation.pathname = '/drive-1/files/page-1';
    render();
    click('[data-slot="list"] button[aria-label="Close sidebar"]');
    click('[data-slot="object"] [data-leading] button[aria-label="Show sidebar"]');

    assert({
      given: 'Show sidebar on a collapsed files tree',
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
    click('[data-slot="list"] button[aria-label="Close sidebar"]');
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

  test('Close sidebar on a stage-2 list', () => {
    navigation.pathname = '/drive-1/files';
    render();
    click('[data-slot="list"] button[aria-label="Close sidebar"]');
    const closed = [
      getUiState().resources.collapsedSections,
      frame().dataset.list,
      slot('list').hasAttribute('inert'),
      navigation.pathname,
    ];
    const opener = slot('chat').querySelector('header [data-leading] button[aria-label="Show sidebar"]');
    click('[data-slot="chat"] [data-leading] button[aria-label="Show sidebar"]');

    assert({
      given: 'the wide Files list closed with no page open, then Show sidebar in Imago’s head',
      should: 'hide the list in place rather than leave the section, offer Show sidebar in Imago’s head, and bring the list back',
      actual: [closed, opener !== null, getUiState().resources.collapsedSections, frame().dataset.list],
      expected: [[['files'], 'closed', true, '/drive-1/files'], true, [], 'list'],
    });
  });

  test('the page head', () => {
    navigation.pathname = '/drive-1/files/page-1';
    render();
    const head = () => slot('object').querySelector('header');
    const close = head()?.querySelector('a[aria-label="Close page"]');
    const controls = [
      close?.getAttribute('href'),
      head()?.querySelector('[data-leading]'),
      [...(head()?.querySelectorAll('button') ?? [])].some((button) => button.textContent === 'Ask'),
    ];
    navigation.pathname = '/drive-1/messages/channel-1';
    render();

    assert({
      given: 'a page open in Files, then a channel open in Messages, with the pane and Imago open',
      should: 'close each page to its own section, with no Show sidebar and no Ask pill',
      actual: [controls, head()?.querySelector('a[aria-label="Close page"]')?.getAttribute('href')],
      expected: [['/drive-1/files', null, false], '/drive-1/messages'],
    });
  });

  test('Imago collapsed beside a page', () => {
    navigation.pathname = '/drive-1/files/page-1';
    render();
    const docked = [
      frame().dataset.imago,
      slot('chat').querySelector('header button[aria-label="Collapse Imago"]') !== null,
      slot('chat').querySelector('button[aria-label="Close Imago"]'),
    ];
    click('[data-slot="chat"] button[aria-label="Collapse Imago"]');
    const ask = [...slot('object').querySelectorAll('header button')].find((button) => button.textContent === 'Ask');
    const collapsed = [
      getUiState().resources.imagoCollapsed,
      frame().dataset.imago,
      slot('chat').hasAttribute('inert'),
      ask !== undefined,
    ];
    if (ask instanceof HTMLElement) act(() => ask.click());

    assert({
      given: 'Imago docked beside a page, Collapse Imago clicked, then the Ask pill',
      should: 'offer only Collapse in Imago’s head, fold Imago to the Ask pill in the page head, then dock it again',
      actual: [
        docked,
        collapsed,
        [getUiState().resources.imagoCollapsed, frame().dataset.imago, [...slot('object').querySelectorAll('header button')].some((button) => button.textContent === 'Ask')],
      ],
      expected: [
        ['docked', true, null],
        [true, 'collapsed', true, true],
        [false, 'docked', false],
      ],
    });
  });

  test('Imago on the ground', () => {
    render();
    const ground = [
      frame().dataset.imago,
      slot('chat').querySelector('header button[aria-label="Close Imago"]') !== null,
      slot('chat').querySelector('button[aria-label="Collapse Imago"]'),
      slot('chat').querySelector('[data-leading]'),
    ];
    click('[data-slot="list"] button[aria-label="Close sidebar"]');
    const opener = slot('chat').querySelector('header [data-leading] button[aria-label="Show sidebar"]') !== null;

    assert({
      given: 'no page open, so Imago fills the middle, then its pane closed',
      should: 'offer Close Imago (not Collapse) in its head, and Show sidebar there once the pane is closed',
      actual: [ground, opener],
      expected: [['ground', true, null, null], true],
    });
  });

  test('Imago closed on the ground', () => {
    render();
    click('[data-slot="chat"] button[aria-label="Close Imago"]');
    const empty = slot('empty').querySelector('section[aria-label="Nothing open"]');

    assert({
      given: 'Close Imago clicked with no page open',
      should: 'record it in the store and swap Imago for the reachable "Nothing open" middle',
      actual: [
        getUiState().resources.imagoClosed,
        frame().dataset.imago,
        slot('chat').hasAttribute('inert'),
        slot('empty').hasAttribute('inert'),
        empty !== null,
      ],
      expected: [true, 'none', true, false, true],
    });
  });

  test('the chat slot', () => {
    render();
    const roomy = [slot('chat').querySelector('aside')?.dataset.density, slot('chat').textContent?.includes('Alpha in context')];
    navigate('/drive-1/files/page-1');

    assert({
      given: 'the drive chat and then an open page',
      should: 'carry the stage’s chat context: roomy over the drive, dense beside the page',
      actual: [roomy, [slot('chat').querySelector('aside')?.dataset.density, slot('chat').textContent?.includes('This page in context')]],
      expected: [
        ['roomy', true],
        ['dense', true],
      ],
    });
  });

  test('the rail', () => {
    render();
    const rail = slot('rail');
    const names = [...rail.querySelectorAll('a[aria-label], button[aria-label], summary[aria-label]')].map((element) =>
      element.getAttribute('aria-label'),
    );
    const messages = rail.querySelector('a[aria-label^="Messages"]');
    navigate('/drive-1/messages/channel-1');
    const current = rail.querySelector(':scope > ul [aria-current]');

    assert({
      given: 'the shell on a drive chat, then on a channel',
      should: 'fill the spine with the drive switcher, Search, the drive’s sections and tools, the bell, Drive settings and the avatar menu (ending in Log out), and move aria-current without remounting the link',
      actual: [
        names,
        [...rail.querySelectorAll('button')].some((button) => button.textContent?.includes('Log out')),
        current === messages,
        rail.querySelectorAll(':scope > ul [aria-current]').length,
        rail.querySelector('summary[aria-label="Account menu"]')?.classList.contains('spine-avatar-ring'),
      ],
      expected: [
        [
          'Switch drive: Alpha',
          'Search',
          'Chat',
          'Files',
          'Messages',
          'Tasks',
          'Calendar',
          'Agents',
          'Workflows',
          'Activity',
          'Members',
          'Trash',
          'Notifications',
          'Drive settings',
          'Account menu',
        ],
        true,
        true,
        1,
        false,
      ],
    });
  });

  test('the rail reopens a collapsed section', () => {
    navigation.pathname = '/drive-1/files/page-1';
    render();
    click('[data-slot="list"] button[aria-label="Close sidebar"]');
    click('[data-slot="rail"] a[aria-label="Files"]');

    assert({
      given: 'the files tree hidden, then Files clicked on the rail',
      should: 'expand the section and slide the tree back beside the page',
      actual: [getUiState().resources.collapsedSections, frame().dataset.list, slot('list').hasAttribute('inert')],
      expected: [[], 'tree', false],
    });
  });

  test('the settings and account navs', () => {
    navigation.pathname = '/drive-1/settings';
    render();
    const settings = [frame().dataset.list, slot('list').querySelector('nav')?.getAttribute('aria-label'), slot('list').classList.contains('w-tree-pane')];
    navigate('/account');
    const account = [frame().dataset.list, slot('list').querySelector('nav')?.getAttribute('aria-label'), slot('list').classList.contains('w-tree-pane')];

    assert({
      given: 'drive settings, then the account',
      should: 'open each one’s 260px nav pane in the list slot',
      actual: [settings, account],
      expected: [
        ['tree', 'Drive settings', true],
        ['tree', 'Account', true],
      ],
    });
  });

  test('the rail on a user-level stage', () => {
    navigation.pathname = '/account';
    render();

    assert({
      given: 'the account stage, which names no drive',
      should: 'link the rail into the Home drive, mark no section current and ring the avatar instead',
      actual: [
        slot('rail').querySelector('a[aria-label="Drive settings"]')?.getAttribute('href'),
        slot('rail').querySelector(':scope > ul [aria-current]'),
        slot('rail').querySelector('summary[aria-label="Account menu"]')?.classList.contains('spine-avatar-ring'),
      ],
      expected: ['/home-1/settings', null, true],
    });
  });

  test('the drive switcher', () => {
    navigation.pathname = '/drive-1/tasks/list-1';
    render();
    const tile = () => slot('rail').querySelector<HTMLButtonElement>('button[aria-label^="Switch drive"]');
    const before = document.querySelector('[role="dialog"][aria-label="Switch drive"]');
    click('button[aria-label="Switch drive: Alpha"]');
    const opened = document.querySelector('[role="dialog"][aria-label="Switch drive"]');

    assert({
      given: 'a task list open in Alpha, and the drive tile pressed',
      should: 'open the Switch drive dialog from the tile, which reports it expanded',
      actual: [before, opened !== null, tile()?.getAttribute('aria-expanded'), tile()?.getAttribute('aria-haspopup')],
      expected: [null, true, 'true', 'dialog'],
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
        rail.querySelector('button[aria-label^="Switch drive"]')?.getAttribute('aria-label'),
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

  test('one chat pane across every navigation', () => {
    render();
    for (const path of ['/drive-1/files/page-1', '/drive-1/tasks', '/dm/conversation-1', '/drive-2']) navigate(path);
    const pane = slot('chat').querySelector('aside');

    assert({
      given: 'the shell moved through files, tasks, a DM and another drive',
      should: 'keep one chat pane mounted, handed the current stage, its drive and the Home drive',
      actual: [chatMounts.count, pane?.dataset.drive, pane?.dataset.home, pane?.textContent?.endsWith('Beta in context')],
      expected: [1, 'drive-2', 'home-1', true],
    });
  });

  test('⌘K over every stage', () => {
    render();
    const before = ['rail', 'list', 'object', 'chat'].map(slot);
    const opened = ['/drive-1', '/drive-1/files/page-1', '/dm/conversation-1'].map((pathname) => {
      navigate(pathname);
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      });
      const palette = container.querySelector('[data-palette]');
      const shown = [
        palette?.parentElement === frame(),
        palette?.querySelector('input')?.getAttribute('placeholder'),
      ];
      act(() => {
        palette?.querySelector('input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      return [...shown, container.querySelector('[data-palette]') === null];
    });

    assert({
      given: 'Ctrl-K, then Escape, on the drive chat, a page and a DM',
      should: 'open the palette over the frame searching the rail’s drive (Home from the DM), close it, and leave the panes mounted',
      actual: [opened, ['rail', 'list', 'object', 'chat'].every((name, index) => slot(name) === before[index])],
      expected: [
        [
          [true, 'Search Alpha…', true],
          [true, 'Search Alpha…', true],
          [true, 'Search Home…', true],
        ],
        true,
      ],
    });
  });
});
