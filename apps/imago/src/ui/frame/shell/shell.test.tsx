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
// The rail's placeholder offers sign-out; its network path is proven in
// lib/auth/sign-out.test.ts.
vi.mock('@/components/SignOutButton', () => ({
  SignOutButton: () => h('button', { type: 'button' }, 'Sign out'),
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

const render = () =>
  act(() => {
    root?.render(h(Shell, null, h(Route)));
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
    const roomy = [slot('chat').querySelector('section')?.dataset.density, slot('chat').textContent?.includes('This drive in context')];
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
});
