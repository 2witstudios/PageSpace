import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ApiError } from '@/api/errors';
import {
  createTask,
  deleteTask,
  fetchDriveTaskLists,
  fetchTaskList,
  fetchTaskStatuses,
  loadTaskTree,
  reorderTasks,
  setTaskAssignees,
  setTaskStatus,
  taskPaths,
  updateTask,
} from './task-api';
import { fakeWeb } from './fake-web';
import { seededConfigs, statusConfig, taskItem, taskListResponse } from '../task-model/fixtures';
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
