// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import type { RealtimeClient, RealtimeSocket } from '@/realtime/realtime-client';
import { click, mount, typeInto, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { pageRow, treeRow } from '../file-model/fixtures';
import type { PageTreeResponse } from '../file-model/file-node';
import { REVALIDATE_DELAY_MS } from '../use-file-tree/use-file-tree';

// The router is Next's seam: opening a page is a push to its address.
const router = vi.hoisted(() => ({ pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => router.pushed.push(href) }),
}));

const { FilesPane } = await import('./files-pane');

beforeEach(() => {
  setUiState(createInitialState());
  router.pushed = [];
});

afterEach(unmountAll);

/** Lets React and SWR flush between tries until `check` passes. */
const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 100; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet: flush again.
    }
  }
  check();
};

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

/** A promise the test settles by hand, so a request can be held in flight. */
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const TREE = 'GET /api/drives/d1/pages';
const CREATE = 'POST /api/pages';
const NEW_TITLE = 'Untitled Document';

/**
 * Drive d1:
 *   Launch (folder) › Brief (doc) › Notes (doc)
 *   Archive (folder, empty)
 *   Readme (doc)
 */
const driveTree = (archive: readonly PageTreeResponse[] = []): readonly PageTreeResponse[] => [
  treeRow('launch', 'FOLDER', [
    treeRow('brief', 'DOCUMENT', [treeRow('notes', 'DOCUMENT', [], { parentId: 'brief', title: 'Notes' })], {
      parentId: 'launch',
      title: 'Brief',
    }),
  ], { title: 'Launch' }),
  treeRow('archive', 'FOLDER', archive, { title: 'Archive', position: 1 }),
  treeRow('readme', 'DOCUMENT', [], { title: 'Readme', position: 2 }),
];

const p9 = treeRow('p9', 'DOCUMENT', [], { parentId: 'archive', title: NEW_TITLE });

const show = (routes: Record<string, FakeRoute>, selectedPageId: string | null = null) => {
  const web = fakeWeb(routes);
  const rt = fakeRealtime();
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={rt.client}>
        <FilesPane driveId="d1" selectedPageId={selectedPageId} variant="tree" title="Files" closeHref="/d1" />
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, rt, container };
};

const tree = (container: HTMLElement) => container.querySelector('[aria-label="File tree"]');

/** Every row's name, in document order. */
const rowNames = (container: HTMLElement): readonly string[] =>
  [...container.querySelectorAll('[aria-label="File tree"] li > div')].map(
    (row) => row.querySelector('.truncate')?.textContent ?? '',
  );

const shown = async (container: HTMLElement) =>
  settle(() => {
    if (tree(container) === null) throw new Error('no tree yet');
  });

const button = (container: HTMLElement, label: string): HTMLButtonElement => {
  const found = container.querySelector(`button[aria-label="${label}"]`);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${label} button`);
  return found;
};

describe('FilesPane browsing', () => {
  test('the drive tree, live', async () => {
    const { container } = show({ [TREE]: () => Response.json(driveTree()) }, 'readme');
    const loading = container.querySelector('[role="status"]')?.textContent;
    await shown(container);

    assert({
      given: 'a drive with the Readme page open',
      should: 'show loading, then its top-level rows linked to their pages with Readme tinted',
      actual: [
        loading,
        rowNames(container),
        [...container.querySelectorAll('[aria-label="File tree"] a')].map((a) => a.getAttribute('href')),
        container.querySelector('a[aria-current="page"]')?.getAttribute('href'),
        container.querySelector('a[aria-current="page"]')?.parentElement?.className.includes('bg-accent-soft'),
      ],
      expected: [
        'Loading pages…',
        ['Launch', 'Archive', 'Readme'],
        ['/d1/files/launch', '/d1/files/archive', '/d1/files/readme'],
        '/d1/files/readme',
        true,
      ],
    });
  });

  test('disclosure', async () => {
    const { container } = show({
      [TREE]: () => Response.json(driveTree()),
      'GET /api/pages/launch/children': () =>
        Response.json([pageRow('brief', 'DOCUMENT', { parentId: 'launch', title: 'Brief' })]),
    });
    await shown(container);
    click(button(container, 'Expand Launch'));
    await settle(() => {
      if (!rowNames(container).includes('Brief')) throw new Error('not open');
    });

    assert({
      given: 'Launch’s caret clicked',
      should: 'open Launch in place, its page nested under it, and keep it open in the store',
      actual: [rowNames(container), getUiState().resources.expandedFileIds],
      expected: [['Launch', 'Brief', 'Archive', 'Readme'], ['launch']],
    });
  });

  test('a page only the children route names', async () => {
    const { container } = show({
      [TREE]: () => Response.json(driveTree()),
      'GET /api/pages/archive/children': () =>
        Response.json([pageRow('secret', 'DOCUMENT', { parentId: 'archive', title: 'Secret' })]),
    });
    await shown(container);
    click(button(container, 'Expand Archive'));
    await settle(() => {
      if (button(container, 'Collapse Archive').getAttribute('aria-expanded') !== 'true') throw new Error('closed');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    assert({
      given: 'a children load naming a page the drive tree did not list',
      should: 'never draw it',
      actual: [rowNames(container), container.textContent?.includes('Secret')],
      expected: [['Launch', 'Archive', 'Readme'], false],
    });
  });

  test('the filter keeps the path to a match', async () => {
    const { container } = show({ [TREE]: () => Response.json(driveTree()) });
    await shown(container);
    const field = container.querySelector('input[aria-label="Filter files"]');
    if (!(field instanceof HTMLInputElement)) throw new Error('no filter');
    typeInto(field, 'note');
    const filtered = rowNames(container);
    typeInto(field, 'zebra');
    const none = [tree(container), container.textContent?.includes('No pages match “zebra”.')];
    typeInto(field, '');

    assert({
      given: 'a filter matching a page two levels down, one matching nothing, then none',
      should: 'show the match with its folder and page above it, then say nothing matched, then the whole tree closed again',
      actual: [filtered, none, rowNames(container), getUiState().resources.expandedFileIds],
      expected: [['Launch', 'Brief', 'Notes'], [null, true], ['Launch', 'Archive', 'Readme'], []],
    });
  });

  test('a tree that will not load, then loads', async () => {
    let calls = 0;
    const { container, web } = show({
      [TREE]: () => {
        calls += 1;
        return calls === 1 ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json(driveTree());
      },
    });
    await settle(() => {
      if (container.querySelector('[role="alert"] button') === null) throw new Error('no retry');
    });
    const failed = {
      title: container.querySelector('[role="alert"] h2')?.textContent,
      create: button(container, 'New page').disabled,
    };
    click(container.querySelector('[role="alert"] button') as HTMLButtonElement);
    await shown(container);

    assert({
      given: 'a failed load, then Try again',
      should: 'draw the retryable error with + off, then the tree SWR loads on retry',
      actual: [failed, web.count(TREE), rowNames(container)],
      expected: [{ title: 'Could not load pages', create: true }, 2, ['Launch', 'Archive', 'Readme']],
    });
  });

  test('a drive with no pages', async () => {
    const { container } = show({ [TREE]: () => Response.json([]) });
    await settle(() => {
      if (container.querySelector('[data-empty]') === null) throw new Error('not loaded');
    });

    assert({
      given: 'an empty drive',
      should: 'draw the designed empty state and no filter or tree, with + on',
      actual: [
        [...(container.querySelector('[data-empty]')?.children ?? [])].map((child) => child.textContent),
        container.querySelector('input[aria-label="Filter files"]'),
        tree(container),
        button(container, 'New page').disabled,
      ],
      expected: [['No pages yet', 'Pages in this drive show up here.'], null, null, false],
    });
  });
});

describe('FilesPane New page', () => {
  test('in the selected folder, at once, then opened', async () => {
    const answer = deferred<Response>();
    let listed = driveTree();
    const { web, container } = show(
      {
        [TREE]: () => Response.json(listed),
        [CREATE]: () => answer.promise,
      },
      'archive',
    );
    await shown(container);
    click(button(container, 'New page'));
    await settle(() => {
      if (!rowNames(container).includes(NEW_TITLE)) throw new Error('no row yet');
    });
    const before = {
      rows: rowNames(container),
      busy: container.querySelector('[aria-busy="true"]')?.textContent,
      expanded: button(container, 'Collapse Archive').getAttribute('aria-expanded'),
      pushed: [...router.pushed],
    };

    listed = driveTree([p9]);
    answer.resolve(Response.json(pageRow('p9', 'DOCUMENT', { parentId: 'archive', title: NEW_TITLE }), { status: 201 }));
    await settle(() => {
      if (container.querySelector('a[href="/d1/files/p9"]') === null) throw new Error('not listed yet');
    });

    assert({
      given: 'the Archive folder open as the object and + pressed',
      should: 'show the new page under Archive at once, POST a document there with CSRF, open it, then draw it from the tree once',
      actual: [
        before,
        web.writes().map(({ method, url, csrf, body }) => ({ method, url, csrf, body })),
        router.pushed,
        rowNames(container),
        container.querySelectorAll('[aria-busy="true"]').length,
        getUiState().resources.pendingFiles,
      ],
      expected: [
        { rows: ['Launch', 'Archive', NEW_TITLE, 'Readme'], busy: NEW_TITLE, expanded: 'true', pushed: [] },
        [
          {
            method: 'POST',
            url: '/api/pages',
            csrf: 'tok-1',
            body: { title: NEW_TITLE, type: 'DOCUMENT', driveId: 'd1', parentId: 'archive' },
          },
        ],
        ['/d1/files/p9'],
        ['Launch', 'Archive', NEW_TITLE, 'Readme'],
        0,
        [],
      ],
    });
  });

  test('nothing selected creates at the top of the drive', async () => {
    const { web, container } = show({
      [TREE]: () => Response.json(driveTree()),
      [CREATE]: () => Response.json(pageRow('p9', 'DOCUMENT', { title: NEW_TITLE }), { status: 201 }),
    });
    await shown(container);
    click(button(container, 'New page'));
    await settle(() => {
      if (router.pushed.length === 0) throw new Error('not opened');
    });

    assert({
      given: 'no page open and + pressed',
      should: 'create the document at the top of the drive and open it',
      actual: [(web.writes()[0]?.body as { parentId: unknown }).parentId, router.pushed, rowNames(container).at(-1)],
      expected: [null, ['/d1/files/p9'], NEW_TITLE],
    });
  });

  test('the tree lists it before the create answers', async () => {
    const answer = deferred<Response>();
    let listed = driveTree();
    const { rt, web, container } = show(
      {
        [TREE]: () => Response.json(listed),
        [CREATE]: () => answer.promise,
      },
      'archive',
    );
    await shown(container);
    click(button(container, 'New page'));
    await settle(() => {
      if (!rowNames(container).includes(NEW_TITLE)) throw new Error('no row yet');
    });

    // realtime's page:created lands first: the drive tree already lists p9.
    listed = driveTree([p9]);
    rt.deliver('page:created', { driveId: 'd1', pageId: 'p9', operation: 'created' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, REVALIDATE_DELAY_MS + 20));
    });
    await settle(() => {
      if (container.querySelector('a[href="/d1/files/p9"]') === null) throw new Error('not revalidated');
    });
    const revalidated = { rows: rowNames(container), busy: container.querySelectorAll('[aria-busy="true"]').length };

    answer.resolve(Response.json(pageRow('p9', 'DOCUMENT', { parentId: 'archive', title: NEW_TITLE }), { status: 201 }));
    await settle(() => {
      if (router.pushed.length === 0) throw new Error('not answered');
    });
    await settle(() => {
      if (getUiState().resources.pendingFiles.length > 0) throw new Error('not settled');
    });

    assert({
      given: 'a socket revalidation listing the new page before the POST answers, then the answer',
      should: 'draw the page once throughout, then open it',
      actual: [revalidated, rowNames(container), router.pushed, web.count(TREE) >= 2],
      expected: [
        { rows: ['Launch', 'Archive', NEW_TITLE, 'Readme'], busy: 0 },
        ['Launch', 'Archive', NEW_TITLE, 'Readme'],
        ['/d1/files/p9'],
        true,
      ],
    });
  });

  test('a refused create rolls back', async () => {
    const answer = deferred<Response>();
    const { container } = show(
      {
        [TREE]: () => Response.json(driveTree()),
        [CREATE]: () => answer.promise,
      },
      'archive',
    );
    await shown(container);
    click(button(container, 'New page'));
    await settle(() => {
      if (!rowNames(container).includes(NEW_TITLE)) throw new Error('no row yet');
    });
    const during = rowNames(container);
    answer.resolve(Response.json({ error: 'Insufficient permissions' }, { status: 403 }));
    await settle(() => {
      if (container.querySelector('[role="alert"]') === null) throw new Error('no alert');
    });

    assert({
      given: 'a create the server refuses',
      should: 'drop the new row, say why, and open nothing',
      actual: [
        during,
        rowNames(container),
        container.querySelector('[role="alert"]')?.textContent,
        router.pushed,
        getUiState().resources.pendingFiles,
      ],
      expected: [
        ['Launch', 'Archive', NEW_TITLE, 'Readme'],
        ['Launch', 'Archive', 'Readme'],
        'Could not create the page. Insufficient permissions',
        [],
        [],
      ],
    });
  });

  test('a create that never reaches the server', async () => {
    const { container } = show({
      [TREE]: () => Response.json(driveTree()),
      [CREATE]: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await shown(container);
    click(button(container, 'New page'));
    await settle(() => {
      if (container.querySelector('[role="alert"]') === null) throw new Error('no alert');
    });

    assert({
      given: 'a create that fails offline',
      should: 'drop the row and say PageSpace could not be reached',
      actual: [rowNames(container), container.querySelector('[role="alert"]')?.textContent],
      expected: [['Launch', 'Archive', 'Readme'], 'Could not create the page. Could not reach PageSpace.'],
    });
  });
});
