import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ApiError } from '@/api/errors';
import {
  createTask,
  deleteTask,
  fetchAssignable,
  fetchDriveTaskLists,
  fetchEveryDriveTask,
  fetchPageContent,
  fetchPagePermissions,
  fetchPageTrail,
  savePageContent,
  fetchTaskList,
  fetchTaskStatuses,
  loadTaskTree,
  reorderTasks,
  setTaskAssignees,
  setTaskStatus,
  taskPaths,
  updateTask,
} from './task-api';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { seededConfigs, statusConfig, taskItem, taskListResponse } from '../task-model/fixtures';
import type { DriveTaskResponse } from '../task-model/task';
import { statusesFrom } from '../task-model/from-api';
import { locate } from '../task-tree/task-tree';

const tasksOf = (pageId: string, offset = 0) => `GET /api/pages/${pageId}/tasks?limit=200&offset=${offset}`;

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

describe('taskPaths', () => {
  test('encoding', () => {
    assert({
      given: 'ids with characters that mean something in a path',
      should: 'encode them into the route',
      actual: taskPaths.task('a/b', 'c?d'),
      expected: '/api/pages/a%2Fb/tasks/c%3Fd',
    });
  });

  test('a drive’s tasks and every drive’s', () => {
    assert({
      given: 'a drive, then no drive (Home, the dashboard)',
      should: 'ask for that drive’s tasks, then the viewer’s across every drive',
      actual: [
        taskPaths.driveTasks({ driveId: 'd1', limit: 20, statusGroup: 'active' }),
        taskPaths.driveTasks({ driveId: null, limit: 20, statusGroup: 'active' }),
      ],
      expected: [
        '/api/tasks?context=drive&driveId=d1&limit=20&statusGroup=active',
        '/api/tasks?context=user&limit=20&statusGroup=active',
      ],
    });
  });
});

describe('fetchDriveTaskLists()', () => {
  test('request and mapping', async () => {
    const web = fakeWeb({
      'GET /api/drives/d1/pages?ls=true&recursive=true': () =>
        Response.json({
          mode: 'ls',
          pages: [
            { id: 'l1', title: 'Launch', type: 'TASK_LIST', hasChildren: true, isTaskLinked: false },
            { id: 't1', title: 'A task', type: 'TASK_LIST', hasChildren: false, isTaskLinked: true },
            { id: 'doc', title: 'Notes', type: 'DOCUMENT', hasChildren: false, isTaskLinked: false },
          ],
        }),
    });

    assert({
      given: 'a drive',
      should: 'list its TASK_LIST pages from every level of the drive tree',
      actual: await fetchDriveTaskLists(web.client, 'd1'),
      expected: [{ pageId: 'l1', title: 'Launch' }],
    });
  });
});

const driveRow = (id: string, list = 'l1'): DriveTaskResponse => ({
  ...taskItem(id),
  driveId: 'd1',
  taskListPageId: list,
  taskListPageTitle: list,
  statusGroup: 'todo',
  statusLabel: 'To Do',
  statusColor: '',
});

const drivePage = (from: number, length: number, list: string, total: number, offset = from) =>
  Response.json({
    tasks: Array.from({ length }, (_, i) => driveRow(`t${from + i}`, list)),
    statusConfigsByTaskList: { [list]: seededConfigs },
    pagination: { total, limit: 100, offset, hasMore: offset + length < total },
  });

const driveRows = (offset = 0) =>
  `GET /api/tasks?context=drive&driveId=d1&limit=100&statusGroup=active${offset === 0 ? '' : `&offset=${offset}`}`;

describe('fetchEveryDriveTask()', () => {
  test('many pages', async () => {
    const web = fakeWeb({
      [driveRows(0)]: () => drivePage(0, 100, 'l1', 250),
      [driveRows(100)]: () => drivePage(100, 100, 'l2', 250),
      [driveRows(200)]: () => drivePage(200, 50, 'l2', 250),
    });
    const every = await fetchEveryDriveTask(web.client, { driveId: 'd1', statusGroup: 'active', limit: 100 });
    assert({
      given: 'more of the viewer’s tasks than one 100-row page holds',
      should: 'follow the offset to the last page, joining every row and every list’s statuses',
      actual: [
        every.tasks.length,
        every.tasks.at(-1)?.id,
        Object.keys(every.statusConfigsByTaskList ?? {}),
        every.pagination.hasMore,
        web.requests.length,
      ],
      expected: [250, 't249', ['l1', 'l2'], false, 3],
    });
  });

  test('a row that moved between pages', async () => {
    const web = fakeWeb({
      [driveRows(0)]: () => drivePage(0, 100, 'l1', 150),
      // t99 was touched between the reads and slid onto the next page too.
      [driveRows(100)]: () => drivePage(99, 51, 'l1', 150, 100),
    });
    const every = await fetchEveryDriveTask(web.client, { driveId: 'd1', statusGroup: 'active', limit: 100 });
    assert({
      given: 'a row the updatedAt order put on two pages',
      should: 'keep it once',
      actual: every.tasks.filter((row) => row.id === 't99').length,
      expected: 1,
    });
  });

  test('a page the route left empty', async () => {
    const web = fakeWeb({
      [driveRows(0)]: () => drivePage(0, 100, 'l1', 250),
      // Every row on the middle page was an orphan the route dropped.
      [driveRows(100)]: () =>
        Response.json({
          tasks: [],
          statusConfigsByTaskList: {},
          pagination: { total: 250, limit: 100, offset: 100, hasMore: true },
        }),
      [driveRows(200)]: () => drivePage(200, 50, 'l2', 250),
    });
    const every = await fetchEveryDriveTask(web.client, { driveId: 'd1', statusGroup: 'active', limit: 100 });
    assert({
      given: 'a middle page with no rows the viewer can see, the route still saying there are more',
      should: 'read on past it to the last page',
      actual: [every.tasks.length, every.tasks.at(-1)?.id, every.pagination.hasMore, web.requests.length],
      expected: [150, 't249', false, 3],
    });
  });

  test('the pages after the first', async () => {
    let open = 0;
    let most = 0;
    const later = (from: number, length: number) => async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 0));
      open -= 1;
      return drivePage(from, length, 'l1', 350);
    };
    const web = fakeWeb({
      [driveRows(0)]: () => drivePage(0, 100, 'l1', 350),
      [driveRows(100)]: later(100, 100),
      [driveRows(200)]: later(200, 100),
      [driveRows(300)]: later(300, 50),
    });
    const every = await fetchEveryDriveTask(web.client, { driveId: 'd1', statusGroup: 'active', limit: 100 });
    assert({
      given: 'a first page whose total says three more follow',
      should: 'ask for all three at once and join them in offset order',
      actual: [most, every.tasks.length, every.tasks[100]?.id, every.tasks.at(-1)?.id],
      expected: [3, 350, 't100', 't349'],
    });
  });

  test('the cap', async () => {
    const routes = Object.fromEntries(
      Array.from({ length: 12 }, (_, page) => [driveRows(page * 100), () => drivePage(page * 100, 100, 'l1', 5000)]),
    );
    const web = fakeWeb(routes);
    const every = await fetchEveryDriveTask(web.client, { driveId: 'd1', statusGroup: 'active', limit: 100 });
    assert({
      given: 'more tasks than the 1000 a drive-wide read takes',
      should: 'stop at 1000 and say there are more',
      actual: [every.tasks.length, every.pagination.hasMore, web.requests.length],
      expected: [1000, true, 10],
    });
  });
});

describe('fetchTaskList()', () => {
  test('one page', async () => {
    const body = taskListResponse([taskItem('t1')]);
    const web = fakeWeb({ [tasksOf('l1')]: () => Response.json(body) });

    assert({
      given: 'a list that fits in one page',
      should: 'answer with the route’s body in one request',
      actual: [await fetchTaskList(web.client, 'l1'), web.requests.length],
      expected: [body, 1],
    });
  });

  test('many pages', async () => {
    const first = Array.from({ length: 200 }, (_, i) => taskItem(`a${i}`));
    const web = fakeWeb({
      [tasksOf('l1', 0)]: () => Response.json(taskListResponse(first, { hasMore: true })),
      [tasksOf('l1', 200)]: () => Response.json(taskListResponse([taskItem('b0')], { hasMore: false })),
    });
    const loaded = await fetchTaskList(web.client, 'l1');

    assert({
      given: 'a list longer than the route’s 200-task page',
      should: 'page through it and join every task in order',
      actual: [loaded.tasks.length, loaded.tasks.at(-1)?.id, loaded.hasMore],
      expected: [201, 'b0', false],
    });
  });

  test('whole-list paging only', async () => {
    const first = Array.from({ length: 200 }, (_, i) => taskItem(`a${i}`, { status: 'completed' }));
    const web = fakeWeb({
      [tasksOf('l1', 0)]: () => Response.json(taskListResponse(first, { hasMore: true })),
      [tasksOf('l1', 200)]: () => Response.json(taskListResponse([taskItem('b0')], { hasMore: false })),
    });
    await fetchTaskList(web.client, 'l1');

    assert({
      given: 'a list that pages, done tasks first',
      should: 'never opt into the route’s statusGroup or perStatus windows, which drop done tasks or count offsets per column',
      actual: web.requests.map((request) => request.url).filter((url) => /statusGroup|perStatus/.test(url)),
      expected: [],
    });
  });

  test('the cap', async () => {
    const full = Array.from({ length: 200 }, (_, i) => taskItem(`t${i}`));
    const routes = Object.fromEntries(
      Array.from({ length: 30 }, (_, page) => [
        tasksOf('l1', page * 200),
        () => Response.json(taskListResponse(full, { hasMore: true })),
      ]),
    );
    const web = fakeWeb(routes);
    const loaded = await fetchTaskList(web.client, 'l1');

    assert({
      given: 'a list longer than the 5000 tasks reorder accepts',
      should: 'stop at 5000 and say there are more',
      actual: [loaded.tasks.length, loaded.hasMore, web.requests.length],
      expected: [5000, true, 25],
    });
  });
});

describe('fetchTaskStatuses()', () => {
  test('request', async () => {
    const web = fakeWeb({
      'GET /api/pages/l1/tasks/statuses': () => Response.json({ statusConfigs: [...seededConfigs].reverse() }),
    });

    assert({
      given: 'a list page',
      should: 'read its own statuses from /statuses, in position order',
      actual: await fetchTaskStatuses(web.client, 'l1'),
      expected: statusesFrom(seededConfigs),
    });
  });
});

describe('loadTaskTree()', () => {
  test('nesting', async () => {
    const own = [statusConfig('icebox', 'todo', 0), statusConfig('shipped', 'done', 1)];
    const web = fakeWeb({
      [tasksOf('l1')]: () =>
        Response.json(taskListResponse([taskItem('a', { subTaskCount: 1 }), taskItem('leaf')])),
      [tasksOf('page-a')]: () =>
        Response.json(taskListResponse([taskItem('b', { subTaskCount: 1 })], { statusConfigs: own })),
      [tasksOf('page-b')]: () => Response.json(taskListResponse([taskItem('c', { subTaskCount: 1 })])),
      [tasksOf('page-c')]: () => Response.json(taskListResponse([taskItem('d', { subTaskCount: 1 })])),
      [tasksOf('page-d')]: () => Response.json(taskListResponse([taskItem('e', { subTaskCount: 1 })])),
    });
    const tree = await loadTaskTree(web.client, 'l1', 'Launch');

    assert({
      given: 'a list nested five levels deep',
      should: 'load every level, each from its own task’s page',
      actual: locate(tree, 'e')?.path.map((entry) => entry.id),
      expected: ['a', 'b', 'c', 'd', 'e'],
    });

    assert({
      given: 'a sub-list with its own statuses',
      should: 'keep that list’s statuses on it',
      actual: locate(tree, 'b')?.lists.at(-1)?.statuses.map((entry) => entry.slug),
      expected: ['icebox', 'shipped'],
    });

    assert({
      given: 'a leaf, and a level-5 task the server says has subtasks',
      should: 'fetch neither: a leaf has nothing, and five levels is the cap',
      actual: [web.count(tasksOf('page-leaf')), web.count(tasksOf('page-e')), web.requests.length],
      expected: [0, 0, 5],
    });

    assert({
      given: 'the root list',
      should: 'carry the title it was opened with',
      actual: tree.title,
      expected: 'Launch',
    });
  });
});

describe('writes', () => {
  const echo = () => Response.json(taskItem('t1'));

  test('create', async () => {
    const web = fakeWeb({ 'POST /api/pages/l1/tasks': () => Response.json(taskItem('t1'), { status: 201 }) });
    await createTask(web.client, 'l1', {
      title: 'Plan',
      status: 'in_progress',
      priority: 'high',
      dueDate: '2026-10-09T00:00:00.000Z',
      assignees: [{ type: 'agent', id: 'ag-1', name: 'Planner' }],
    });

    assert({
      given: 'a new task',
      should: 'POST it to the list’s page with the CSRF token',
      actual: web.writes(),
      expected: [
        {
          method: 'POST',
          url: '/api/pages/l1/tasks',
          csrf: 'tok-1',
          body: {
            title: 'Plan',
            status: 'in_progress',
            priority: 'high',
            dueDate: '2026-10-09T00:00:00.000Z',
            assigneeIds: [{ type: 'agent', id: 'ag-1' }],
          },
        },
      ],
    });
  });

  test('create, title only', async () => {
    const web = fakeWeb({ 'POST /api/pages/l1/tasks': () => Response.json(taskItem('t1'), { status: 201 }) });
    await createTask(web.client, 'l1', { title: 'Plan' });

    assert({
      given: 'a new task with only a title',
      should: 'send only the title, so the server picks the seed status',
      actual: web.writes()[0]?.body,
      expected: { title: 'Plan' },
    });
  });

  test('update, status, assignees, delete', async () => {
    const web = fakeWeb({
      'PATCH /api/pages/l1/tasks/t1': echo,
      'DELETE /api/pages/l1/tasks/t1': () => Response.json({ success: true }),
    });
    const at = { listPageId: 'l1', taskId: 't1' };
    await updateTask(web.client, at, { title: 'Renamed', priority: 'low', dueDate: null });
    await setTaskStatus(web.client, at, 'completed');
    await setTaskAssignees(web.client, at, [
      { type: 'user', id: 'u-ada', name: 'Ada' },
      { type: 'agent', id: 'ag-1', name: 'Planner' },
    ]);
    await deleteTask(web.client, at);

    assert({
      given: 'an edit, a status, assignees and a delete for one task',
      should: 'address each to the task under the list that holds it, with the CSRF token',
      actual: web.writes(),
      expected: [
        { method: 'PATCH', url: '/api/pages/l1/tasks/t1', csrf: 'tok-1', body: { title: 'Renamed', priority: 'low', dueDate: null } },
        { method: 'PATCH', url: '/api/pages/l1/tasks/t1', csrf: 'tok-1', body: { status: 'completed' } },
        {
          method: 'PATCH',
          url: '/api/pages/l1/tasks/t1',
          csrf: 'tok-1',
          body: { assigneeIds: [{ type: 'user', id: 'u-ada' }, { type: 'agent', id: 'ag-1' }] },
        },
        { method: 'DELETE', url: '/api/pages/l1/tasks/t1', csrf: 'tok-1', body: undefined },
      ],
    });
  });

  test('reorder', async () => {
    const web = fakeWeb({ 'PATCH /api/pages/page-p/tasks/reorder': () => Response.json({ success: true }) });
    await reorderTasks(web.client, {
      listPageId: 'page-p',
      tasks: [
        { id: 'c', position: 0 },
        { id: 'a', position: 1 },
      ],
    });

    assert({
      given: 'a new order for a list',
      should: 'PATCH /tasks/reorder on that list with every task’s position',
      actual: web.writes(),
      expected: [
        {
          method: 'PATCH',
          url: '/api/pages/page-p/tasks/reorder',
          csrf: 'tok-1',
          body: { tasks: [{ id: 'c', position: 0 }, { id: 'a', position: 1 }] },
        },
      ],
    });
  });

  test('the server’s refusal', async () => {
    const web = fakeWeb({
      'PATCH /api/pages/l1/tasks/p': () =>
        Response.json(
          { code: 'SUBTASKS_INCOMPLETE', error: 'Complete all sub-tasks first (1 of 2 remaining)', pending: 1, total: 2 },
          { status: 422 },
        ),
    });
    const error = await rejection(setTaskStatus(web.client, { listPageId: 'l1', taskId: 'p' }, 'completed'));

    assert({
      given: 'a completion the server refuses',
      should: 'reject with its code and words',
      actual: error instanceof ApiError ? [error.status, error.code, error.message] : error,
      expected: [422, 'SUBTASKS_INCOMPLETE', 'Complete all sub-tasks first (1 of 2 remaining)'],
    });
  });
});

describe('assignee writes', () => {
  test('the same person twice', async () => {
    const web = fakeWeb({ 'PATCH /api/pages/l1/tasks/t': () => Response.json(taskItem('t')) });
    await setTaskAssignees(web.client, { listPageId: 'l1', taskId: 't' }, [
      { type: 'user', id: 'u-1', name: 'Ada' },
      { type: 'agent', id: 'u-1', name: 'Agent with a colliding id' },
      { type: 'user', id: 'u-1', name: 'Ada' },
    ]);

    assert({
      given: 'a set naming one person twice',
      should: 'send each person or agent once, since task_assignees is unique per task and user',
      actual: web.writes().map((write) => write.body),
      expected: [
        {
          assigneeIds: [
            { type: 'user', id: 'u-1' },
            { type: 'agent', id: 'u-1' },
          ],
        },
      ],
    });
  });

  test('create with the same person twice', async () => {
    const web = fakeWeb({ 'POST /api/pages/l1/tasks': () => Response.json(taskItem('t')) });
    await createTask(web.client, 'l1', {
      title: 'Ship',
      assignees: [
        { type: 'agent', id: 'a-1', name: 'Planner' },
        { type: 'agent', id: 'a-1', name: 'Planner' },
      ],
    });

    assert({
      given: 'a new task naming one agent twice',
      should: 'send the agent once',
      actual: (web.writes()[0]?.body as { assigneeIds: unknown }).assigneeIds,
      expected: [{ type: 'agent', id: 'a-1' }],
    });
  });
});

describe('fetchAssignable()', () => {
  test('request and mapping', async () => {
    const web = fakeWeb({
      'GET /api/drives/d1/assignees': () =>
        Response.json({
          assignees: [
            { id: 'u-1', type: 'user', name: 'Ada', image: null },
            { id: 'a-1', type: 'agent', name: 'Planner', image: null, agentTitle: 'Planner' },
          ],
        }),
    });

    assert({
      given: 'a drive',
      should: 'list its members and the agents the viewer can see, from the drive assignees route',
      actual: await fetchAssignable(web.client, 'd1'),
      expected: [
        { type: 'user', id: 'u-1', name: 'Ada' },
        { type: 'agent', id: 'a-1', name: 'Planner' },
      ],
    });
  });
});

describe('fetchPageTrail()', () => {
  test('request and mapping', async () => {
    const web = fakeWeb({
      'GET /api/pages/page-a/breadcrumbs': () =>
        Response.json([
          { id: 'l1', title: 'Launch', type: 'TASK_LIST', parentId: null, driveId: 'd1', drive: null },
          { id: 'page-p', title: 'Plan', type: 'TASK_LIST', parentId: 'l1', driveId: 'd1', drive: null },
          { id: 'page-a', title: 'Draft', type: 'TASK_LIST', parentId: 'page-p', driveId: 'd1', drive: null },
        ]),
    });

    assert({
      given: 'a task’s page',
      should: 'list its ancestors from the top of the drive down to the page itself',
      actual: await fetchPageTrail(web.client, 'page-a'),
      expected: [
        { id: 'l1', title: 'Launch' },
        { id: 'page-p', title: 'Plan' },
        { id: 'page-a', title: 'Draft' },
      ],
    });
  });
});

describe('page content', () => {
  test('read', async () => {
    const web = fakeWeb({
      'GET /api/pages/page-a': () => Response.json({ id: 'page-a', content: '<p>Notes</p>' }),
      'GET /api/pages/page-b': () => Response.json({ id: 'page-b', content: null }),
    });

    assert({
      given: 'a task’s page, with and without content',
      should: 'read its content, empty when it has none',
      actual: [await fetchPageContent(web.client, 'page-a'), await fetchPageContent(web.client, 'page-b')],
      expected: ['<p>Notes</p>', ''],
    });
  });

  test('save', async () => {
    const web = fakeWeb({ 'PATCH /api/pages/page-a': () => Response.json({ id: 'page-a' }) });
    await savePageContent(web.client, 'page-a', '<p>New</p>');

    assert({
      given: 'a new description',
      should: 'PATCH the task’s own page with it and the CSRF token',
      actual: web.writes(),
      expected: [{ method: 'PATCH', url: '/api/pages/page-a', csrf: 'tok-1', body: { content: '<p>New</p>' } }],
    });
  });
});

describe('fetchPagePermissions()', () => {
  test('request', async () => {
    const web = fakeWeb({
      'GET /api/pages/page-a/permissions/check': () =>
        Response.json({ canView: true, canEdit: false, canShare: false, canDelete: false }),
    });

    assert({
      given: 'a task’s page',
      should: 'read what the viewer may do on it',
      actual: await fetchPagePermissions(web.client, 'page-a'),
      expected: { canView: true, canEdit: false, canShare: false, canDelete: false },
    });
  });
});
