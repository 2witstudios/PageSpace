// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import type { RealtimeClient, RealtimeSocket } from '@/realtime/realtime-client';
import { click, mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { pageRow, treeRow } from '../file-model/fixtures';
import type { PageTreeResponse } from '../file-model/file-node';
import { REVALIDATE_DELAY_MS } from '../use-file-tree/use-file-tree';

// The router is Next's seam: opening a page is a push to its address.
const router = vi.hoisted(() => ({ pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => router.pushed.push(href) }),
}));

const { FolderView } = await import('./folder-view');

beforeEach(() => {
  setUiState(createInitialState());
  router.pushed = [];
});

afterEach(unmountAll);

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 2000, interval: 5 }));

type Listener = (...args: unknown[]) => void;

/** realtime standing in: one connected socket that delivers events to this tab. */
const fakeRealtime = () => {
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
  const client: RealtimeClient = { socket: () => socket, disconnect: () => {} };
  const deliver = (event: string, payload: unknown) =>
    act(() => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    });
  return { client, deliver };
};

const TREE = 'GET /api/drives/d1/pages';
const CREATE = 'POST /api/pages';
const NEW_TITLE = 'Untitled Document';

/** The clock the Modified column reads: 5 October 2026, mid-morning UTC. */
const now = () => new Date('2026-10-05T10:00:00.000Z');

/**
 * Drive d1:
 *   Work (folder) › Launch (folder) › Brief (doc, today), Budget (sheet, 2025)
 *   Archive (folder, empty)
 */
const driveTree = (launch: readonly PageTreeResponse[] = []): readonly PageTreeResponse[] => [
  treeRow(
    'work',
    'FOLDER',
    [
      treeRow(
        'launch',
        'FOLDER',
        [
          treeRow('brief', 'DOCUMENT', [], {
            parentId: 'launch',
            title: 'Brief',
            updatedAt: '2026-10-05T09:12:00.000Z',
          }),
          treeRow('budget', 'SHEET', [], {
            parentId: 'launch',
            title: 'Budget',
            position: 1,
            updatedAt: '2025-12-31T10:00:00.000Z',
          }),
          ...launch,
        ],
        { parentId: 'work', title: 'Launch' },
      ),
    ],
    { title: 'Work' },
  ),
  treeRow('archive', 'FOLDER', [], { title: 'Archive', position: 1 }),
];

const show = (routes: Record<string, FakeRoute>, folderId: string) => {
  const web = fakeWeb(routes);
  const rt = fakeRealtime();
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={rt.client}>
        <FolderView driveId="d1" folderId={folderId} now={now} />
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, rt, container };
};

const rowNames = (container: HTMLElement) =>
  [...container.querySelectorAll('tbody tr [data-name]')].map((name) => name.textContent);

const listed = (container: HTMLElement) =>
  settle(() => {
    if (container.querySelector('table, [data-empty]') === null) throw new Error('not listed yet');
  });

describe('FolderView browsing', () => {
  test('a folder from the drive tree', async () => {
    const { web, container } = show({ [TREE]: () => Response.json(driveTree()) }, 'launch');
    await listed(container);
    assert({
      given: 'a folder the drive tree lists, two levels down',
      should:
        'list its children from the drive tree with when each changed, under a path from Files through Work, asking apps/web for nothing but the tree',
      actual: [
        [...container.querySelectorAll('tbody tr')].map((row) => [
          row.querySelector('[data-name]')?.textContent,
          row.querySelector('[data-modified]')?.textContent,
        ]),
        [...container.querySelectorAll('nav[aria-label="Folder path"] li')].map((crumb) => crumb.textContent),
        web.requests.map((request) => request.url),
      ],
      expected: [
        [
          ['Brief', 'Today, 9:12 AM'],
          ['Budget', 'Dec 31, 2025'],
        ],
        ['Files', '›Work', '›Launch'],
        ['/api/drives/d1/pages'],
      ],
    });
  });

  test('only what the drive tree lists', async () => {
    // The children route would also name a page the drive tree does not
    // (it checks only the parent); the browser never asks it.
    const { web, container } = show(
      {
        [TREE]: () => Response.json(driveTree()),
        'GET /api/pages/launch/children': () =>
          Response.json([pageRow('secret', 'DOCUMENT', { parentId: 'launch', title: 'Secret' })]),
      },
      'launch',
    );
    await listed(container);
    assert({
      given: 'a folder whose children route would list a page the viewer may not see',
      should: 'draw only the drive tree’s children and never call the children route',
      actual: [rowNames(container), web.count('GET /api/pages/launch/children')],
      expected: [['Brief', 'Budget'], 0],
    });
  });

  test('live', async () => {
    let tree = driveTree();
    const { rt, container } = show({ [TREE]: () => Response.json(tree) }, 'launch');
    await listed(container);
    tree = driveTree([treeRow('plan', 'DOCUMENT', [], { parentId: 'launch', title: 'Plan', position: 2 })]);
    rt.deliver('page:created', { driveId: 'd1', pageId: 'plan', operation: 'created' });
    await act(() => new Promise((resolve) => setTimeout(resolve, REVALIDATE_DELAY_MS)));
    await settle(() => {
      if (!rowNames(container).includes('Plan')) throw new Error('not yet');
    });
    assert({
      given: 'someone else adds a page to the open folder',
      should: 'list it once realtime says the drive changed',
      actual: rowNames(container),
      expected: ['Brief', 'Budget', 'Plan'],
    });
  });

  test('into a child', async () => {
    const { container } = show({ [TREE]: () => Response.json(driveTree()) }, 'work');
    await listed(container);
    assert({
      given: 'a folder holding a folder',
      should: 'link the child folder to its own address, where it opens in the browser',
      actual: container.querySelector('tbody tr a')?.getAttribute('href'),
      expected: '/d1/files/launch',
    });
  });
});

describe('FolderView empty', () => {
  test('an empty folder creates a page in it', async () => {
    const { web, container } = show(
      {
        [TREE]: () => Response.json(driveTree()),
        [CREATE]: () =>
          Response.json(pageRow('p9', 'DOCUMENT', { parentId: 'archive', title: NEW_TITLE }), { status: 201 }),
      },
      'archive',
    );
    await listed(container);
    const empty = container.querySelector('[data-empty]');
    const button = empty?.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no New page');
    click(button);
    await settle(() => {
      if (router.pushed.length === 0) throw new Error('not opened');
    });
    assert({
      given: 'New page pressed in the empty state of an empty folder',
      should: 'create one document in that folder through the pages API, then open it',
      actual: [
        empty?.querySelector('h2')?.textContent,
        web.writes().map((request) => [request.url, request.body]),
        router.pushed,
      ],
      expected: [
        'This folder is empty',
        [['/api/pages', { title: NEW_TITLE, type: 'DOCUMENT', driveId: 'd1', parentId: 'archive' }]],
        ['/d1/files/p9'],
      ],
    });
  });

  test('the new page shows while it is created', async () => {
    let answer: (response: Response) => void = () => {};
    const { container } = show(
      {
        [TREE]: () => Response.json(driveTree()),
        [CREATE]: () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      },
      'archive',
    );
    await listed(container);
    const button = container.querySelector('[data-empty] button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no New page');
    click(button);
    await settle(() => {
      if (rowNames(container).length === 0) throw new Error('no row yet');
    });
    const during = [rowNames(container), container.querySelector('tbody tr')?.getAttribute('aria-busy')];
    answer(Response.json(pageRow('p9', 'DOCUMENT', { parentId: 'archive', title: NEW_TITLE }), { status: 201 }));
    await settle(() => {
      if (router.pushed.length === 0) throw new Error('not opened');
    });
    assert({
      given: 'a create in the empty folder the server has not answered yet',
      should: 'list the new page at once, busy, in place of the empty state',
      actual: during,
      expected: [[NEW_TITLE], 'true'],
    });
  });

  test('a create that fails', async () => {
    const { container } = show(
      {
        [TREE]: () => Response.json(driveTree()),
        [CREATE]: () => Response.json({ error: 'Insufficient permissions' }, { status: 403 }),
      },
      'archive',
    );
    await listed(container);
    const button = container.querySelector('[data-empty] button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no New page');
    click(button);
    await settle(() => {
      if (container.querySelector('[role="alert"]') === null) throw new Error('no alert yet');
    });
    assert({
      given: 'a create the server refuses',
      should: 'keep the folder empty and say why',
      actual: [
        container.querySelector('[data-empty] h2')?.textContent,
        container.querySelector('[role="alert"]')?.textContent,
        router.pushed,
      ],
      expected: ['This folder is empty', 'Could not create the page. Insufficient permissions', []],
    });
  });
});

describe('FolderView edges', () => {
  test('while the tree loads', () => {
    const { container } = show({ [TREE]: () => new Promise<Response>(() => {}) }, 'launch');
    assert({
      given: 'the drive tree on its way',
      should: 'say the folder is loading',
      actual: container.querySelector('[role="status"]')?.textContent,
      expected: 'Loading folder…',
    });
  });

  test('a tree that fails, then answers', async () => {
    let fail = true;
    const { container } = show(
      {
        [TREE]: () => {
          if (fail) return Response.json({ error: 'boom' }, { status: 500 });
          return Response.json(driveTree());
        },
      },
      'launch',
    );
    await settle(() => {
      if (container.querySelector('[data-error]') === null) throw new Error('no error yet');
    });
    const title = container.querySelector('[data-error] h2')?.textContent;
    fail = false;
    const retry = container.querySelector('[data-error] button');
    if (!(retry instanceof HTMLButtonElement)) throw new Error('no retry');
    click(retry);
    await listed(container);
    assert({
      given: 'the drive tree fails, and Try again is pressed',
      should: 'say the folder could not load, then list it',
      actual: [title, rowNames(container)],
      expected: ['Could not load this folder', ['Brief', 'Budget']],
    });
  });

  test('a folder the drive tree does not list', async () => {
    const { container } = show({ [TREE]: () => Response.json(driveTree()) }, 'elsewhere');
    await settle(() => {
      if (container.querySelector('[data-not-found]') === null) throw new Error('not settled');
    });
    assert({
      given: 'a folder id the viewer’s drive tree does not hold',
      should: 'draw not-found with the way back to Files, and no contents',
      actual: [
        container.querySelector('[data-not-found] h2')?.textContent,
        container.querySelector('[data-not-found] a')?.getAttribute('href'),
        container.querySelector('table'),
      ],
      expected: ['Page not found', '/d1/files', null],
    });
  });
});
