// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import {
  useAssignable,
  useDriveTaskLists,
  usePageTrail,
  useTaskList,
  useTaskStatuses,
  type TaskActions,
} from './use-tasks';
import type { Assignee } from '../task-model/task';
import type { TrailEntry } from '../task-api/task-api';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { seededConfigs, taskItem, taskListResponse } from '../task-model/fixtures';
import { statusesFrom } from '../task-model/from-api';
import { locate } from '../task-tree/task-tree';
import type { TaskList, TaskListSummary, TaskStatus } from '../task-model/task';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

// SWR resolves outside React's event loop; waiting inside act() flushes the
// state updates it causes.
const settle = (check: () => void): Promise<void> =>
  act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

const render = (tree: ReactNode): void => {
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => {
    root.render(tree);
  });
};

const L1 = 'GET /api/pages/l1/tasks?limit=200&offset=0';
const PAGE_P = 'GET /api/pages/page-p/tasks?limit=200&offset=0';

/** A list l1 holding parent p (one open subtask a) and leaf z. */
const listRoutes = (overrides: Record<string, FakeRoute> = {}) => ({
  [L1]: () =>
    Response.json(
      taskListResponse([taskItem('p', { subTaskCount: 1, position: 0 }), taskItem('z', { position: 1 })]),
    ),
  [PAGE_P]: () => Response.json(taskListResponse([taskItem('a')])),
  ...overrides,
});

type Seen = { list: TaskList | undefined; actions: TaskActions | null };

const mountList = (routes: Record<string, FakeRoute>) => {
  const web = fakeWeb(routes);
  const seen: Seen = { list: undefined, actions: null };
  function Probe() {
    const { list, actions } = useTaskList('l1', 'Launch');
    seen.list = list;
    seen.actions = actions;
    return null;
  }
  render(
    <ImagoSWRProvider client={web.client}>
      <Probe />
    </ImagoSWRProvider>,
  );
  return { web, seen };
};

const loaded = async (seen: Seen) => {
  await settle(() => {
    if (!seen.list) throw new Error('not loaded');
  });
  return seen.list as TaskList;
};

const statusIn = (list: TaskList | undefined, id: string) =>
  list ? locate(list, id)?.path.at(-1)?.status : undefined;

/**
 * A route that answers its first request at once and holds every later one
 * until released, so a test can read the tree after a refused write but
 * before the revalidation that follows it answers.
 */
const heldAfterFirst = (answer: () => Response) => {
  let calls = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const route: FakeRoute = async () => {
    calls += 1;
    if (calls > 1) await held;
    return answer();
  };
  return { route, release: () => release(), calls: () => calls };
};

describe('useDriveTaskLists()', () => {
  test('loading', async () => {
    const web = fakeWeb({
      'GET /api/drives/d1/pages?ls=true&recursive=true': () =>
        Response.json({
          mode: 'ls',
          pages: [
            { id: 'l1', title: 'Launch', type: 'TASK_LIST', hasChildren: true, isTaskLinked: false },
            { id: 't1', title: 'Task', type: 'TASK_LIST', hasChildren: false, isTaskLinked: true },
          ],
        }),
    });
    const seen: { lists?: readonly TaskListSummary[] } = {};
    function Probe() {
      seen.lists = useDriveTaskLists('d1').lists;
      return null;
    }
    render(
      <ImagoSWRProvider client={web.client}>
        <Probe />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!seen.lists) throw new Error('not loaded');
    });

    assert({
      given: 'a drive',
      should: 'give its task lists',
      actual: seen.lists,
      expected: [{ pageId: 'l1', title: 'Launch' }],
    });
  });

  test('no drive', () => {
    const web = fakeWeb({});
    const seen: { lists?: readonly TaskListSummary[] } = {};
    function Probe() {
      seen.lists = useDriveTaskLists(null).lists;
      return null;
    }
    render(
      <ImagoSWRProvider client={web.client}>
        <Probe />
      </ImagoSWRProvider>,
    );

    assert({
      given: 'no drive yet',
      should: 'fetch nothing',
      actual: [seen.lists, web.requests.length],
      expected: [undefined, 0],
    });
  });
});

describe('useTaskStatuses()', () => {
  test('loading', async () => {
    const web = fakeWeb({
      'GET /api/pages/l1/tasks/statuses': () => Response.json({ statusConfigs: seededConfigs }),
    });
    const seen: { statuses?: readonly TaskStatus[] } = {};
    function Probe() {
      seen.statuses = useTaskStatuses('l1').statuses;
      return null;
    }
    render(
      <ImagoSWRProvider client={web.client}>
        <Probe />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!seen.statuses) throw new Error('not loaded');
    });

    assert({
      given: 'a list page',
      should: 'give its statuses',
      actual: seen.statuses,
      expected: statusesFrom(seededConfigs),
    });
  });
});

describe('useTaskList()', () => {
  test('loading', async () => {
    const { seen } = mountList(listRoutes());
    const list = await loaded(seen);

    assert({
      given: 'a task list with a parent and its subtask',
      should: 'give the whole tree under the list’s title',
      actual: [list.title, locate(list, 'a')?.path.map((entry) => entry.id)],
      expected: ['Launch', ['p', 'a']],
    });
  });

  test('a status change', async () => {
    let served = 'pending';
    const { web, seen } = mountList(
      listRoutes({
        [PAGE_P]: () => Response.json(taskListResponse([taskItem('a', { status: served })])),
        'PATCH /api/pages/page-p/tasks/a': ({ body }) => {
          served = (body as { status: string }).status;
          return Response.json(taskItem('a', { status: served }));
        },
      }),
    );
    await loaded(seen);
    const before = web.count(PAGE_P);

    let result: unknown;
    await act(async () => {
      result = await seen.actions?.setStatus('a', 'in_progress');
    });

    assert({
      given: 'a subtask moved to another status',
      should: 'PATCH it under the list that holds it, with the CSRF token',
      actual: web.writes(),
      expected: [{ method: 'PATCH', url: '/api/pages/page-p/tasks/a', csrf: 'tok-1', body: { status: 'in_progress' } }],
    });

    assert({
      given: 'a status change the server accepts',
      should: 'succeed',
      actual: result,
      expected: { ok: true },
    });

    await settle(() => {
      if (web.count(PAGE_P) === before) throw new Error('not revalidated');
    });

    assert({
      given: 'a saved status change',
      should: 'revalidate the list from the server',
      actual: [web.count(PAGE_P) > before, statusIn(seen.list, 'a')],
      expected: [true, 'in_progress'],
    });
  });

  test('a refused completion', async () => {
    const { web, seen } = mountList(listRoutes());
    await loaded(seen);

    let result: unknown;
    await act(async () => {
      result = await seen.actions?.toggleComplete('p');
    });

    assert({
      given: 'a parent with an open subtask ticked',
      should: 'refuse in the server’s words without asking it',
      actual: [result, web.writes().length],
      expected: [{ ok: false, refusal: 'Complete all sub-tasks first (1 of 1 remaining)' }, 0],
    });
  });

  test('a completion the server refuses', async () => {
    const list = heldAfterFirst(() =>
      Response.json(taskListResponse([taskItem('p', { subTaskCount: 0 })])),
    );
    const { web, seen } = mountList(
      listRoutes({
        [L1]: list.route,
        'PATCH /api/pages/l1/tasks/p': () =>
          Response.json(
            { code: 'SUBTASKS_INCOMPLETE', error: 'Complete all sub-tasks first (1 of 1 remaining)', pending: 1, total: 1 },
            { status: 422 },
          ),
      }),
    );
    await loaded(seen);

    let result: unknown;
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = (async () => {
        result = await seen.actions?.toggleComplete('p');
      })();
    });
    // The refusal has landed and the revalidating GET is waiting on the server.
    await settle(() => {
      if (list.calls() < 2) throw new Error('not revalidating yet');
    });
    const beforeServerAnswers = statusIn(seen.list, 'p');
    list.release();
    await act(() => done);

    assert({
      given: 'a completion the server refuses (a subtask added elsewhere)',
      should: 'report the server’s refusal',
      actual: [result, web.writes().length],
      expected: [{ ok: false, refusal: 'Complete all sub-tasks first (1 of 1 remaining)' }, 1],
    });

    assert({
      given: 'a refused write, before the server has answered the revalidation',
      should: 'have rolled the list back already',
      actual: beforeServerAnswers,
      expected: 'pending',
    });
  });

  test('a network failure', async () => {
    const list = heldAfterFirst(() =>
      Response.json(
        taskListResponse([taskItem('p', { subTaskCount: 1, position: 0 }), taskItem('z', { position: 1 })]),
      ),
    );
    const { seen } = mountList(
      listRoutes({
        [L1]: list.route,
        'PATCH /api/pages/l1/tasks/z': () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    );
    await loaded(seen);

    let result: unknown;
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = (async () => {
        result = await seen.actions?.update('z', { priority: 'high' });
      })();
    });
    await settle(() => {
      if (list.calls() < 2) throw new Error('not revalidating yet');
    });
    const beforeServerAnswers = seen.list?.tasks[1]?.priority;
    list.release();
    await act(() => done);

    assert({
      given: 'a write that never reaches the server',
      should: 'say so and roll back before the revalidation answers',
      actual: [result, beforeServerAnswers],
      expected: [{ ok: false, refusal: 'Could not reach PageSpace' }, 'medium'],
    });
  });

  test('create, assignees, delete and reorder', async () => {
    const { web, seen } = mountList(
      listRoutes({
        'POST /api/pages/page-p/tasks': () => Response.json(taskItem('new'), { status: 201 }),
        'PATCH /api/pages/l1/tasks/z': () => Response.json(taskItem('z')),
        'DELETE /api/pages/page-p/tasks/a': () => Response.json({ success: true }),
        'PATCH /api/pages/l1/tasks/reorder': () => Response.json({ success: true }),
      }),
    );
    await loaded(seen);
    const ada = { type: 'user' as const, id: 'u-ada', name: 'Ada' };
    const results: unknown[] = [];

    await act(async () => {
      results.push(await seen.actions?.create('page-p', { title: 'Plan', status: 'in_progress' }));
    });
    await act(async () => {
      results.push(await seen.actions?.setAssignees('z', [ada]));
    });
    await act(async () => {
      results.push(await seen.actions?.toggleAssignee('z', { type: 'agent', id: 'ag-1', name: 'Planner' }));
    });
    await act(async () => {
      results.push(await seen.actions?.remove('a'));
    });
    await act(async () => {
      results.push(await seen.actions?.move('z', 0));
    });

    assert({
      given: 'each kind of write',
      should: 'succeed',
      actual: results,
      expected: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }],
    });

    assert({
      given: 'each kind of write',
      should: 'call the existing task endpoints, each with the CSRF token',
      actual: web.writes().map(({ method, url, csrf, body }) => [method, url, csrf, body]),
      expected: [
        ['POST', '/api/pages/page-p/tasks', 'tok-1', { title: 'Plan', status: 'in_progress' }],
        ['PATCH', '/api/pages/l1/tasks/z', 'tok-1', { assigneeIds: [{ type: 'user', id: 'u-ada' }] }],
        [
          'PATCH',
          '/api/pages/l1/tasks/z',
          'tok-1',
          { assigneeIds: [{ type: 'agent', id: 'ag-1' }] },
        ],
        ['DELETE', '/api/pages/page-p/tasks/a', 'tok-1', undefined],
        ['PATCH', '/api/pages/l1/tasks/reorder', 'tok-1', { tasks: [{ id: 'z', position: 0 }, { id: 'p', position: 1 }] }],
      ],
    });
  });

  test('refusals that never reach the server', async () => {
    const { web, seen } = mountList(listRoutes());
    await loaded(seen);
    const results: unknown[] = [];

    await act(async () => {
      results.push(await seen.actions?.create('l1', { title: '  ' }));
      results.push(await seen.actions?.update('z', { title: '' }));
      results.push(await seen.actions?.setStatus('nope', 'completed'));
      results.push(await seen.actions?.toggleComplete('nope'));
      results.push(await seen.actions?.setAssignees('nope', []));
      results.push(await seen.actions?.toggleAssignee('nope', { type: 'user', id: 'u', name: '' }));
      results.push(await seen.actions?.remove('nope'));
      results.push(await seen.actions?.move('nope', 0));
    });

    assert({
      given: 'writes the server would refuse, or for tasks this list does not hold',
      should: 'refuse them without a request',
      actual: [results, web.writes().length],
      expected: [
        [
          { ok: false, refusal: 'Title is required' },
          { ok: false, refusal: 'Title cannot be empty' },
          { ok: false, refusal: 'Task not found' },
          { ok: false, refusal: 'Task not found' },
          { ok: false, refusal: 'Task not found' },
          { ok: false, refusal: 'Task not found' },
          { ok: false, refusal: 'Task not found' },
          { ok: false, refusal: 'Task not found' },
        ],
        0,
      ],
    });
  });

  test('no list and a new title', async () => {
    const web = fakeWeb(listRoutes());
    const seen: { none?: TaskList; statuses?: readonly TaskStatus[]; list?: TaskList } = {};
    function Probe({ title }: { title: string }) {
      seen.none = useTaskList(null, 'Nothing').list;
      seen.statuses = useTaskStatuses(null).statuses;
      seen.list = useTaskList('l1', title).list;
      return null;
    }
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    const tree = (title: string) => (
      <ImagoSWRProvider client={web.client}>
        <Probe title={title} />
      </ImagoSWRProvider>
    );
    act(() => root.render(tree('Launch')));
    await settle(() => {
      if (!seen.list) throw new Error('not loaded');
    });
    act(() => root.render(tree('Launch v2')));

    assert({
      given: 'no list page and no status page',
      should: 'fetch neither',
      actual: [seen.none, seen.statuses, web.count('GET /api/pages/l1/tasks/statuses')],
      expected: [undefined, undefined, 0],
    });

    assert({
      given: 'the list renamed in the list pane after it loaded',
      should: 'show the new title without refetching',
      actual: [seen.list?.title, web.count(L1)],
      expected: ['Launch v2', 1],
    });
  });

  test('before the list loads', () => {
    const web = fakeWeb({ [L1]: () => new Promise<Response>(() => {}) });
    const seen: Seen = { list: undefined, actions: null };
    function Probe() {
      const { list, actions } = useTaskList('l1', 'Launch');
      seen.list = list;
      seen.actions = actions;
      return null;
    }
    render(
      <ImagoSWRProvider client={web.client}>
        <Probe />
      </ImagoSWRProvider>,
    );

    return act(async () => {
      const result = await seen.actions?.setStatus('p', 'completed');
      assert({
        given: 'a write before the list has loaded',
        should: 'refuse it: there is nothing to apply it to',
        actual: result,
        expected: { ok: false, refusal: 'Task list is still loading' },
      });
    });
  });
});

describe('setAssignees() with a repeat', () => {
  test('one person chosen twice', async () => {
    let answer: () => void = () => {};
    const { web, seen } = mountList(
      listRoutes({
        'PATCH /api/pages/l1/tasks/z': () =>
          new Promise<Response>((resolve) => {
            answer = () => resolve(Response.json(taskItem('z')));
          }),
      }),
    );
    await loaded(seen);
    const ada: Assignee = { type: 'user', id: 'u-ada', name: 'Ada' };
    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = seen.actions?.setAssignees('z', [ada, ada]);
    });
    await settle(() => {
      if (web.writes().length === 0) throw new Error('not sent');
    });
    const shown = seen.list ? locate(seen.list, 'z')?.task.assignees : undefined;
    await act(async () => {
      answer();
      await pending;
    });

    assert({
      given: 'the same person chosen twice',
      should: 'send them once, matching the set shown (unique task and user would 500)',
      actual: web.writes().map((write) => write.body),
      expected: [{ assigneeIds: [{ type: 'user', id: 'u-ada' }] }],
    });
    assert({
      given: 'the same person chosen twice',
      should: 'show them once while the write is in flight',
      actual: shown,
      expected: [ada],
    });
  });
});

describe('useAssignable() and usePageTrail()', () => {
  test('reads', async () => {
    const web = fakeWeb({
      'GET /api/drives/d1/assignees': () =>
        Response.json({ assignees: [{ id: 'u-1', type: 'user', name: 'Ada', image: null }] }),
      'GET /api/pages/page-a/breadcrumbs': () =>
        Response.json([
          { id: 'l1', title: 'Launch', type: 'TASK_LIST', parentId: null, driveId: 'd1', drive: null },
          { id: 'page-a', title: 'Draft', type: 'TASK_LIST', parentId: 'l1', driveId: 'd1', drive: null },
        ]),
    });
    const seen: { people?: readonly Assignee[]; trail?: readonly TrailEntry[]; none?: unknown } = {};
    function Probe() {
      seen.people = useAssignable('d1').assignable;
      seen.trail = usePageTrail('page-a').trail;
      seen.none = usePageTrail(null).trail;
      return null;
    }
    render(
      <ImagoSWRProvider client={web.client}>
        <Probe />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!seen.people || !seen.trail) throw new Error('not loaded');
    });

    assert({
      given: 'a drive and a task page',
      should: 'read who can be assigned and where the page sits, and ask nothing for no page',
      actual: { people: seen.people, trail: seen.trail, none: seen.none, asked: web.requests.length },
      expected: {
        people: [{ type: 'user', id: 'u-1', name: 'Ada' }],
        trail: [
          { id: 'l1', title: 'Launch' },
          { id: 'page-a', title: 'Draft' },
        ],
        none: undefined,
        asked: 2,
      },
    });
  });
});
