// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import type { RealtimeClient, RealtimeSocket } from '@/realtime/realtime-client';
import { fakeWeb, type FakeRoute } from '@/ui/tasks/task-api/fake-web';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { pageRow, treeRow } from '../file-model/fixtures';
import type { FileNode, PageTreeResponse } from '../file-model/file-node';
import { TREE_EVENTS, useFileTree, type FileTree } from './use-file-tree';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  setUiState(createInitialState());
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

// SWR resolves outside React's event loop; waiting inside act() flushes the
// state updates it causes.
const settle = (check: () => void): Promise<void> =>
  act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

type Listener = (...args: unknown[]) => void;

/** realtime standing in: one connected socket that records what is sent and delivers events. */
const fakeRealtime = () => {
  const listeners = new Map<string, Set<Listener>>();
  const sent: unknown[][] = [];
  const socket: RealtimeSocket = {
    connected: true,
    emit: (event, ...args) => {
      sent.push([event, ...args]);
      return socket;
    },
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
  /** realtime relaying an event to this tab. */
  const deliver = (event: string, payload: unknown) =>
    act(() => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    });
  return { client, sent, deliver };
};

const TREE = 'GET /api/drives/d1/pages';
const F1_CHILDREN = 'GET /api/pages/f1/children';

/** Drive d1: folder f1 holding a document, and a sheet at the top. */
const driveTree = (title = 'Title doc'): readonly PageTreeResponse[] => [
  treeRow('f1', 'FOLDER', [treeRow('doc', 'DOCUMENT', [], { parentId: 'f1', title })]),
  treeRow('sheet', 'SHEET', [], { position: 1 }),
];

const mountTree = (routes: Record<string, FakeRoute>, initialDrive: string | null = 'd1') => {
  const web = fakeWeb(routes);
  const rt = fakeRealtime();
  const seen: { tree: FileTree | null } = { tree: null };
  let setDrive: (driveId: string | null) => void = () => {};
  function Probe() {
    const [driveId, set] = useState(initialDrive);
    setDrive = set;
    seen.tree = useFileTree(driveId);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const tree: ReactNode = (
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={rt.client}>
        <Probe />
      </RealtimeProvider>
    </ImagoSWRProvider>
  );
  act(() => {
    root.render(tree);
  });
  const current = (): FileTree => {
    if (seen.tree === null) throw new Error('not rendered');
    return seen.tree;
  };
  const switchDrive = (driveId: string | null) => act(() => setDrive(driveId));
  return { web, rt, current, switchDrive, unmount: () => act(() => root.unmount()) };
};

const loaded = async (current: () => FileTree): Promise<readonly FileNode[]> => {
  await settle(() => {
    if (!current().nodes) throw new Error('not loaded');
  });
  return current().nodes ?? [];
};

/** Ids as a nested outline, `children` marked unknown with '?'. */
const outline = (nodes: readonly FileNode[] | undefined): unknown[] =>
  (nodes ?? []).map((node) => (node.children === undefined ? node.id : [node.id, outline(node.children)]));

const nameOf = (nodes: readonly FileNode[] | undefined, id: string): string | undefined => {
  for (const node of nodes ?? []) {
    if (node.id === id) return node.name;
    const below = nameOf(node.children, id);
    if (below !== undefined) return below;
  }
  return undefined;
};

describe('useFileTree() loading', () => {
  test('a drive', async () => {
    const { web, current } = mountTree({ [TREE]: () => Response.json(driveTree()) });
    const nodes = await loaded(current);

    assert({
      given: 'a drive',
      should: 'load its page tree from the drive pages route as file nodes',
      actual: [web.requests.map((request) => request.url), nodes],
      expected: [
        ['/api/drives/d1/pages'],
        [
          {
            id: 'f1',
            name: 'Title f1',
            kind: 'folder',
            pageType: 'FOLDER',
            count: 1,
            children: [{ id: 'doc', name: 'Title doc', kind: 'page', pageType: 'DOCUMENT' }],
          },
          { id: 'sheet', name: 'Title sheet', kind: 'page', pageType: 'SHEET' },
        ],
      ],
    });
  });

  test('no drive', () => {
    const { web, rt, current } = mountTree({}, null);

    assert({
      given: 'no drive yet',
      should: 'fetch nothing and join no room',
      actual: [current().nodes, web.requests.length, rt.sent],
      expected: [undefined, 0, []],
    });
  });

  test('a refused drive', async () => {
    const { current } = mountTree({
      [TREE]: () => Response.json({ error: 'Drive not found' }, { status: 404 }),
    });
    await settle(() => {
      if (current().error === undefined) throw new Error('no error yet');
    });

    assert({
      given: 'a drive the server will not list',
      should: 'give its error and no nodes',
      actual: [current().nodes, (current().error as Error).message],
      expected: [undefined, 'Drive not found'],
    });
  });
});

describe('useFileTree() lazy children', () => {
  test('expanding a folder', async () => {
    const { web, current } = mountTree({
      [TREE]: () => Response.json(driveTree()),
      [F1_CHILDREN]: () =>
        Response.json([
          pageRow('doc', 'DOCUMENT', { parentId: 'f1' }),
          pageRow('new', 'CODE', { parentId: 'f1', position: 1 }),
        ]),
    });
    await loaded(current);
    await act(async () => current().toggle('f1'));

    assert({
      given: 'a folder expanded',
      should: 'record it as expanded at once',
      actual: [current().expandedIds, getUiState().resources.expandedFileIds],
      expected: [['f1'], ['f1']],
    });

    await settle(() => {
      if (nameOf(current().nodes, 'new') === undefined) throw new Error('children not merged');
    });

    assert({
      given: 'its children loaded from the children route',
      should: 'show them under it',
      actual: [web.count(F1_CHILDREN), outline(current().nodes)],
      expected: [1, [['f1', ['doc', 'new']], 'sheet']],
    });
  });

  test('collapsing a folder', async () => {
    const { web, current } = mountTree({
      [TREE]: () => Response.json(driveTree()),
      [F1_CHILDREN]: () => Response.json([pageRow('doc', 'DOCUMENT', { parentId: 'f1' })]),
    });
    await loaded(current);
    await act(async () => current().toggle('f1'));
    await settle(() => {
      if (web.count(F1_CHILDREN) !== 1) throw new Error('not loaded');
    });
    await act(async () => current().toggle('f1'));

    assert({
      given: 'an expanded folder collapsed',
      should: 'collapse it without asking the server again',
      actual: [current().expandedIds, web.count(F1_CHILDREN)],
      expected: [[], 1],
    });
  });

  test('loading children directly', async () => {
    let answer: (response: Response) => void = () => {};
    const { current } = mountTree({
      [TREE]: () => Response.json(driveTree()),
      [F1_CHILDREN]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    await loaded(current);

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = current().loadChildren('f1');
    });

    assert({
      given: 'a folder’s children requested (as a folder browser does on open)',
      should: 'mark it loading while they are on their way',
      actual: current().loadingIds,
      expected: ['f1'],
    });

    let result: unknown;
    await act(async () => {
      answer(Response.json([pageRow('only', 'DOCUMENT', { parentId: 'f1' })]));
      result = await pending;
    });

    assert({
      given: 'the children arriving',
      should: 'merge them under the folder without expanding it',
      actual: [result, current().loadingIds, current().expandedIds, outline(current().nodes)],
      expected: [{ ok: true }, [], [], [['f1', ['only']], 'sheet']],
    });
  });

  test('asked twice at once', async () => {
    let answer: (response: Response) => void = () => {};
    const { web, current } = mountTree({
      [TREE]: () => Response.json(driveTree()),
      [F1_CHILDREN]: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    await loaded(current);

    let results: unknown[] = [];
    await act(async () => {
      const both = Promise.all([current().loadChildren('f1'), current().loadChildren('f1')]);
      answer(Response.json([pageRow('doc', 'DOCUMENT', { parentId: 'f1' })]));
      results = await both;
    });

    assert({
      given: 'the same children asked for again while on their way',
      should: 'share the one request',
      actual: [web.count(F1_CHILDREN), results],
      expected: [1, [{ ok: true }, { ok: true }]],
    });
  });

  test('no drive open', async () => {
    const { web, current, switchDrive } = mountTree(
      {
        [TREE]: () => Response.json(driveTree()),
        [F1_CHILDREN]: () => Response.json([pageRow('only', 'DOCUMENT', { parentId: 'f1' })]),
      },
      null,
    );

    let result: unknown;
    await act(async () => {
      result = await current().loadChildren('f1');
    });

    assert({
      given: 'children asked for with no drive open',
      should: 'refuse without a request',
      actual: [result, web.requests.length],
      expected: [{ ok: false, refusal: 'No drive is open' }, 0],
    });

    switchDrive('d1');
    await loaded(current);
    await act(async () => {
      result = await current().loadChildren('f1');
    });

    assert({
      given: 'a drive opened afterwards',
      should: 'load and show its children',
      actual: [result, outline(current().nodes)],
      expected: [{ ok: true }, [['f1', ['only']], 'sheet']],
    });
  });

  test('another drive opened', async () => {
    let answer: (response: Response) => void = () => {};
    const { current, switchDrive } = mountTree({
      [TREE]: () => Response.json(driveTree()),
      'GET /api/drives/d2/pages': () => Response.json([treeRow('other', 'DOCUMENT')]),
      [F1_CHILDREN]: () => Response.json([pageRow('loaded', 'DOCUMENT', { parentId: 'f1' })]),
      'GET /api/pages/sheet/children': () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    await loaded(current);
    await act(async () => {
      await current().loadChildren('f1');
    });
    let late: Promise<unknown> = Promise.resolve();
    act(() => {
      late = current().loadChildren('sheet');
    });

    switchDrive('d2');
    await settle(() => {
      if (nameOf(current().nodes, 'other') === undefined) throw new Error('d2 not loaded');
    });
    await act(async () => {
      answer(Response.json([pageRow('late', 'DOCUMENT', { parentId: 'sheet' })]));
      await late;
    });
    const onD2 = outline(current().nodes);

    switchDrive('d1');
    const backOnD1 = outline(current().nodes);

    assert({
      given: 'another drive opened while children were loading, then the first drive again',
      should: 'show each drive’s own tree, with the first drive’s own loads but not the answer that landed meanwhile',
      actual: [onD2, backOnD1],
      expected: [['other'], [['f1', ['loaded']], 'sheet']],
    });
  });

  test('a failed load', async () => {
    const { current } = mountTree({
      [TREE]: () => Response.json(driveTree()),
      [F1_CHILDREN]: () => new Response('Forbidden', { status: 403 }),
    });
    const before = outline(await loaded(current));

    let result: unknown;
    await act(async () => {
      result = await current().loadChildren('f1');
    });

    assert({
      given: 'children the server refuses',
      should: 'report it and keep the tree as it was',
      actual: [result, current().loadingIds, outline(current().nodes)],
      expected: [{ ok: false, refusal: 'Request failed with status 403' }, [], before],
    });
  });

  test('offline', async () => {
    const { current } = mountTree({
      [TREE]: () => Response.json(driveTree()),
      [F1_CHILDREN]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await loaded(current);

    let result: unknown;
    await act(async () => {
      result = await current().loadChildren('f1');
    });

    assert({
      given: 'a load that never reaches the server',
      should: 'say so',
      actual: result,
      expected: { ok: false, refusal: 'Could not reach PageSpace' },
    });
  });
});

describe('useFileTree() live', () => {
  test('joining the drive', async () => {
    const { rt, current } = mountTree({ [TREE]: () => Response.json(driveTree()) });
    await loaded(current);

    assert({
      given: 'a drive’s tree in view',
      should: 'join the drive’s realtime room, where page events are sent',
      actual: rt.sent,
      expected: [['join_drive', 'd1']],
    });
  });

  test('a page renamed elsewhere', async () => {
    let title = 'Title doc';
    const { web, rt, current } = mountTree({
      [TREE]: () => Response.json(driveTree(title)),
      [F1_CHILDREN]: () => Response.json([pageRow('doc', 'DOCUMENT', { parentId: 'f1', title })]),
    });
    await loaded(current);
    await act(async () => current().toggle('f1'));
    await settle(() => {
      if (web.count(F1_CHILDREN) !== 1) throw new Error('not loaded');
    });
    const expandedBefore = current().expandedIds;

    title = 'Renamed';
    await rt.deliver('page:updated', { driveId: 'd1', pageId: 'doc', operation: 'updated', title });
    await settle(() => {
      if (nameOf(current().nodes, 'doc') !== 'Renamed') throw new Error('not revalidated');
    });

    assert({
      given: 'page:updated for the drive',
      should: 'revalidate the tree from the server',
      actual: [web.count(TREE), nameOf(current().nodes, 'doc')],
      expected: [2, 'Renamed'],
    });

    assert({
      given: 'the revalidated tree',
      should: 'keep the expanded folder expanded, holding its pages',
      actual: [current().expandedIds === expandedBefore, current().expandedIds, outline(current().nodes)[0]],
      expected: [true, ['f1'], ['f1', ['doc']]],
    });
  });

  test('every tree event', async () => {
    const { web, rt, current } = mountTree({ [TREE]: () => Response.json(driveTree()) });
    await loaded(current);
    const counts: number[] = [];
    for (const event of TREE_EVENTS) {
      const before = web.count(TREE);
      await rt.deliver(event, { driveId: 'd1', pageId: 'doc', operation: event.slice('page:'.length) });
      await settle(() => {
        if (web.count(TREE) === before) throw new Error(`${event} did not revalidate`);
      });
      counts.push(web.count(TREE) - before);
    }

    assert({
      given: 'each page tree event for the drive',
      should: 'revalidate the tree once',
      actual: [TREE_EVENTS, counts],
      expected: [
        ['page:created', 'page:updated', 'page:moved', 'page:trashed', 'page:restored', 'page:deleted'],
        [1, 1, 1, 1, 1, 1],
      ],
    });
  });

  test('a burst of events', async () => {
    const { web, rt, current } = mountTree({ [TREE]: () => Response.json(driveTree()) });
    await loaded(current);
    await rt.deliver('page:created', { driveId: 'd1', pageId: 'a', operation: 'created' });
    await rt.deliver('page:moved', { driveId: 'd1', pageId: 'a', operation: 'moved' });
    await rt.deliver('page:updated', { driveId: 'd1', pageId: 'b', operation: 'updated' });
    await settle(() => {
      if (web.count(TREE) !== 2) throw new Error('not revalidated');
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));

    assert({
      given: 'several tree events at once (a move reorders many pages)',
      should: 'revalidate once for all of them',
      actual: web.count(TREE),
      expected: 2,
    });
  });

  test('unmounting mid-burst', async () => {
    const { web, rt, current, unmount } = mountTree({ [TREE]: () => Response.json(driveTree()) });
    await loaded(current);
    await rt.deliver('page:created', { driveId: 'd1', pageId: 'a', operation: 'created' });
    unmount();
    roots = [];
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));

    assert({
      given: 'the tree unmounted before its burst settled',
      should: 'not refetch',
      actual: web.count(TREE),
      expected: 1,
    });
  });

  test('events that are not this drive’s tree', async () => {
    const { web, rt, current } = mountTree({ [TREE]: () => Response.json(driveTree()) });
    await loaded(current);
    await rt.deliver('page:updated', { driveId: 'd2', pageId: 'x', operation: 'updated' });
    await rt.deliver('page:updated', 'garbage');
    await rt.deliver('page:content-updated', { driveId: 'd1', pageId: 'doc', operation: 'content-updated' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));

    assert({
      given: 'another drive’s event, a malformed payload and a content edit',
      should: 'not refetch the tree',
      actual: web.count(TREE),
      expected: 1,
    });
  });

  test('a newer tree over loaded children', async () => {
    let children = [pageRow('doc', 'DOCUMENT', { parentId: 'f1' }), pageRow('extra', 'DOCUMENT', { parentId: 'f1' })];
    const { web, rt, current } = mountTree({
      [TREE]: () => Response.json(driveTree()),
      [F1_CHILDREN]: () => Response.json(children),
    });
    await loaded(current);
    await act(async () => current().toggle('f1'));
    await settle(() => {
      if (nameOf(current().nodes, 'extra') === undefined) throw new Error('not merged');
    });

    children = [];
    await rt.deliver('page:trashed', { driveId: 'd1', pageId: 'extra', operation: 'trashed' });
    await settle(() => {
      if (web.count(TREE) !== 2) throw new Error('not revalidated');
    });
    await settle(() => {
      if (nameOf(current().nodes, 'extra') !== undefined) throw new Error('stale children shown');
    });

    assert({
      given: 'a tree revalidated after children were loaded',
      should: 'show the newer tree rather than the older children',
      actual: [outline(current().nodes), current().expandedIds],
      expected: [[['f1', ['doc']], 'sheet'], ['f1']],
    });
  });
});
