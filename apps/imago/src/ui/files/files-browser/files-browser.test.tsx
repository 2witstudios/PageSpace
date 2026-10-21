// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import type { RealtimeClient, RealtimeSocket } from '@/realtime/realtime-client';
import { click, mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { treeRow } from '../file-model/fixtures';
import type { PageTreeResponse } from '../file-model/file-node';
import { VIEW_STORAGE_KEY } from './files-browser-model';

const router = vi.hoisted(() => ({ pushed: [] as string[] }));
const favorites = vi.hoisted(() => ({ add: vi.fn(async () => {}), remove: vi.fn(async () => {}) }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => router.pushed.push(href) }),
}));
// The retained layer is the seam: its surface is a passthrough, its favorites store is recorded.
vi.mock('@/retained-adapters/retained-provider', async () => {
  const { createElement } = await import('react');
  return {
    RetainedSurface: ({ children }: { readonly children: ReactNode }) => createElement('div', null, children),
  };
});
vi.mock('@/retained/hooks/useFavorites', () => ({
  useFavorites: { getState: () => ({ addFavorite: favorites.add, removeFavorite: favorites.remove }) },
}));
// Each dialog stands in as a button that confirms with a fixed answer, shown only while open.
vi.mock('@/retained/components/dialogs/RenameDialog', async () => {
  const { createElement } = await import('react');
  return {
    RenameDialog: (props: { readonly isOpen: boolean; readonly onRename: (title: string) => void }) =>
      props.isOpen ? createElement('button', { type: 'button', 'data-dialog': 'rename', onClick: () => props.onRename('Renamed') }, 'Confirm rename') : null,
  };
});
vi.mock('@/retained/components/dialogs/DeletePageDialog', async () => {
  const { createElement } = await import('react');
  return {
    DeletePageDialog: (props: { readonly isOpen: boolean; readonly onConfirm: (trashChildren: boolean) => void }) =>
      props.isOpen ? createElement('button', { type: 'button', 'data-dialog': 'trash', onClick: () => props.onConfirm(false) }, 'Confirm trash') : null,
  };
});
vi.mock('@/retained/components/dialogs/MovePageDialog', async () => {
  const { createElement } = await import('react');
  return {
    MovePageDialog: (props: { readonly isOpen: boolean }) => (props.isOpen ? createElement('div', { 'data-dialog': 'move' }) : null),
  };
});
vi.mock('@/retained/components/dialogs/CopyPageDialog', async () => {
  const { createElement } = await import('react');
  return {
    CopyPageDialog: (props: { readonly isOpen: boolean }) => (props.isOpen ? createElement('div', { 'data-dialog': 'copy' }) : null),
  };
});

const { FilesBrowser } = await import('./files-browser');

beforeEach(() => {
  setUiState(createInitialState());
  router.pushed = [];
  favorites.add.mockClear();
  favorites.remove.mockClear();
  window.localStorage.clear();
});

afterEach(unmountAll);

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 2000, interval: 5 }));

type Listener = (...args: unknown[]) => void;

/** realtime standing in: one connected socket; nothing is delivered in these tests. */
const fakeRealtime = (): RealtimeClient => {
  const listeners = new Map<string, Set<Listener>>();
  const socket: RealtimeSocket = {
    connected: true,
    emit: () => socket,
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
      return socket;
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
      return socket;
    },
    connect: () => socket,
    disconnect: () => socket,
  };
  return { socket: () => socket, disconnect: () => {} };
};

const TREE = 'GET /api/drives/d1/pages';
const FAVS = 'GET /api/user/favorites';
const CREATE = 'POST /api/pages';

/**
 * Drive d1:
 *   Work (folder) › Launch (folder) › Brief (doc), Budget (sheet)
 *   Archive (folder, empty)
 */
const driveTree = (): readonly PageTreeResponse[] => [
  treeRow(
    'work',
    'FOLDER',
    [
      treeRow(
        'launch',
        'FOLDER',
        [
          treeRow('brief', 'DOCUMENT', [], { parentId: 'launch', title: 'Brief', updatedAt: '2026-10-05T09:12:00.000Z' }),
          treeRow('budget', 'SHEET', [], { parentId: 'launch', title: 'Budget', position: 1, updatedAt: '2025-12-31T10:00:00.000Z' }),
        ],
        { parentId: 'work', title: 'Launch' },
      ),
    ],
    { title: 'Work' },
  ),
  treeRow('archive', 'FOLDER', [], { title: 'Archive', position: 1 }),
];

const defaultRoutes = (extra: Record<string, FakeRoute> = {}): Record<string, FakeRoute> => ({
  [TREE]: () => Response.json(driveTree()),
  [FAVS]: () => Response.json({ favorites: [] }),
  'POST /api/storage/check': () => Response.json({}),
  ...extra,
});

const show = (folderIds: readonly string[], routes: Record<string, FakeRoute> = defaultRoutes()) => {
  const web = fakeWeb(routes);
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={fakeRealtime()}>
        <FilesBrowser driveId="d1" folderIds={folderIds} />
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, container };
};

const rowNames = (container: HTMLElement) =>
  [...container.querySelectorAll('tbody tr [data-name]')].map((name) => name.textContent);

const header = (container: HTMLElement, label: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll('th button')].find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`no ${label} header`);
  return button;
};

const actionsFor = (container: HTMLElement, title: string): HTMLButtonElement => {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${title}"]`);
  if (button === null) throw new Error(`no actions for ${title}`);
  return button;
};

const menuItem = (container: HTMLElement, label: string): HTMLElement => {
  const item = [...container.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent === label);
  if (!(item instanceof HTMLElement)) throw new Error(`no ${label} menu item`);
  return item;
};

/** The browser has drawn: a list, tiles, the empty state or not-found. */
const drawn = (container: HTMLElement) =>
  settle(() => {
    if (container.querySelector('table, [data-page-type], [data-testid="files-empty-state"], [data-not-found]') === null) {
      throw new Error('not drawn yet');
    }
  });

describe('the folder browser', () => {
  test('lists a folder’s pages by name, and sorts by a column when its heading is pressed', async () => {
    const { container } = show(['work', 'launch']);
    await drawn(container);
    const before = rowNames(container);
    click(header(container, 'Name'));
    await settle(() => {
      if (rowNames(container)[0] !== 'Budget') throw new Error('not re-sorted');
    });
    assert({
      given: 'a folder two levels down, opened by name ascending',
      should: 'list its pages A to Z, then descending with aria-sort once Name is pressed again',
      actual: [before, rowNames(container), header(container, 'Name').closest('th')?.getAttribute('aria-sort')],
      expected: [['Brief', 'Budget'], ['Budget', 'Brief'], 'descending'],
    });
  });

  test('the Grid view is remembered for the next visit', async () => {
    const { container } = show(['work', 'launch']);
    await drawn(container);
    click([...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Grid view') as HTMLButtonElement);
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    unmountAll();
    const again = show(['work', 'launch']).container;
    await drawn(again);
    assert({
      given: 'Grid chosen and the browser opened again',
      should: 'store grid under imago:files-view and open in the grid view',
      actual: [stored, again.querySelector('table'), again.querySelector('[aria-label="Grid view"]')?.getAttribute('aria-pressed')],
      expected: ['grid', null, 'true'],
    });
  });

  test('Rename from a row’s actions renames the page through the pages API', async () => {
    const { web, container } = show(['work', 'launch'], defaultRoutes({ 'PATCH /api/pages/brief': () => Response.json({}) }));
    await drawn(container);
    click(actionsFor(container, 'Brief'));
    await settle(() => {
      if (container.querySelector('[role="menu"]') === null) throw new Error('no menu');
    });
    click(menuItem(container, 'Rename'));
    click(container.querySelector('[data-dialog="rename"]') as HTMLElement);
    await settle(() => {
      if (!web.writes().some((request) => request.method === 'PATCH')) throw new Error('not renamed');
    });
    assert({
      given: 'Rename chosen on Brief and confirmed',
      should: 'send PATCH /api/pages/brief with the new title, and close the menu',
      actual: [web.writes().map((request) => [request.method, request.url, request.body]), container.querySelector('[role="menu"]')],
      expected: [[['PATCH', '/api/pages/brief', { title: 'Renamed' }]], null],
    });
  });

  test('Favorite from a row’s actions adds the page to favorites', async () => {
    const { container } = show(['work', 'launch']);
    await drawn(container);
    click(actionsFor(container, 'Brief'));
    await settle(() => {
      if (container.querySelector('[role="menu"]') === null) throw new Error('no menu');
    });
    click(menuItem(container, 'Favorite'));
    await settle(() => {
      if (favorites.add.mock.calls.length === 0) throw new Error('not added');
    });
    assert({
      given: 'Favorite chosen on an unfavorited page',
      should: 'add the page through the favorites store',
      actual: favorites.add.mock.calls,
      expected: [['brief']],
    });
  });

  test('an empty folder creates a page in it and opens it', async () => {
    const { web, container } = show(
      ['archive'],
      defaultRoutes({
        [CREATE]: () => Response.json({ id: 'p9', title: 'Untitled Document', type: 'DOCUMENT', parentId: 'archive' }, { status: 201 }),
      }),
    );
    await drawn(container);
    click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Create page') as HTMLButtonElement);
    await settle(() => {
      if (router.pushed.length === 0) throw new Error('not opened');
    });
    assert({
      given: 'Create page pressed in an empty folder',
      should: 'create one document under that folder through the pages API, then open it',
      actual: [
        web.writes().map((request) => [request.url, request.body]),
        router.pushed,
      ],
      expected: [[['/api/pages', { title: 'Untitled Document', type: 'DOCUMENT', driveId: 'd1', parentId: 'archive' }]], ['/d1/files/p9']],
    });
  });

  test('files dragged over an empty folder say how many go into it', async () => {
    const { container } = show(['archive']);
    await drawn(container);
    const section = container.querySelector('section[aria-label="Pages browser"]') as HTMLElement;
    const enter = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(enter, 'dataTransfer', {
      value: { types: ['Files'], items: [{ kind: 'file' }, { kind: 'file' }] },
    });
    act(() => {
      section.dispatchEvent(enter);
    });
    assert({
      given: 'two files dragged over an empty folder',
      should: 'name the count and the folder they would go into',
      actual: container.querySelector('[data-testid="files-empty-state"] p:last-child')?.textContent,
      expected: 'Drop to upload 2 files into Archive',
    });
  });

  test('a folder the drive tree does not hold draws not-found, not a list', async () => {
    const { container } = show(['work', 'launch', 'brief']);
    await settle(() => {
      if (container.querySelector('[data-not-found]') === null) throw new Error('not settled');
    });
    assert({
      given: 'a path ending in a page rather than a folder',
      should: 'draw not-found with the way back to Files, and no table',
      actual: [container.querySelector('[data-not-found] a')?.getAttribute('href'), container.querySelector('table')],
      expected: ['/d1/files/browse', null],
    });
  });
});
