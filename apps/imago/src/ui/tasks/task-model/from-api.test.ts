import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks';
import {
  assigneesOf,
  defaultStatuses,
  driveTaskLists,
  statusesFrom,
  taskFromItem,
  taskListFrom,
} from './from-api';
import { seededConfigs, statusConfig, taskItem, taskListResponse } from './fixtures';

describe('defaultStatuses', () => {
  test('parity with the server', () => {
    assert({
      given: 'the statuses PageSpace seeds a new list with',
      should: 'be exactly the server’s DEFAULT_TASK_STATUSES, in order',
      actual: defaultStatuses.map(({ slug, name, color, group, position }) => ({
        slug,
        name,
        color,
        group,
        position,
      })),
      expected: DEFAULT_TASK_STATUSES.map(({ slug, name, color, group, position }) => ({
        slug,
        name,
        color,
        group,
        position,
      })),
    });
  });
});

describe('statusesFrom()', () => {
  test('ordering', () => {
    const configs = [
      statusConfig('done', 'done', 2),
      statusConfig('todo', 'todo', 0),
      statusConfig('doing', 'in_progress', 1),
    ];

    assert({
      given: 'status configs out of position order',
      should: 'order them by position, keeping only what the model reads',
      actual: statusesFrom(configs),
      expected: [
        { id: 'cfg-todo', slug: 'todo', name: 'todo', color: 'bg-slate-100', group: 'todo', position: 0 },
        { id: 'cfg-doing', slug: 'doing', name: 'doing', color: 'bg-slate-100', group: 'in_progress', position: 1 },
        { id: 'cfg-done', slug: 'done', name: 'done', color: 'bg-slate-100', group: 'done', position: 2 },
      ],
    });
  });
});

describe('assigneesOf()', () => {
  test('multiple assignees', () => {
    const item = taskItem('t1', {
      assigneeId: 'u-ada',
      assignee: { id: 'u-ada', name: 'Ada', image: null },
      assignees: [
        { id: 'a1', taskId: 't1', userId: 'u-ada', agentPageId: null, user: { id: 'u-ada', name: 'Ada', image: null } },
        { id: 'a2', taskId: 't1', userId: 'u-lin', agentPageId: null, user: { id: 'u-lin', name: 'Lin', image: null } },
        { id: 'a3', taskId: 't1', userId: null, agentPageId: 'ag-1', agentPage: { id: 'ag-1', title: 'Planner', type: 'AI_CHAT' } },
      ],
    });

    assert({
      given: 'a task with people and an agent in task_assignees',
      should: 'list every one of them, people and agents alike',
      actual: assigneesOf(item),
      expected: [
        { type: 'user', id: 'u-ada', name: 'Ada' },
        { type: 'user', id: 'u-lin', name: 'Lin' },
        { type: 'agent', id: 'ag-1', name: 'Planner' },
      ],
    });
  });

  test('unnamed rows', () => {
    const item = taskItem('t1', {
      assignees: [
        { id: 'a1', taskId: 't1', userId: 'u-x', agentPageId: null, user: { id: 'u-x', name: null, image: null } },
        { id: 'a2', taskId: 't1', userId: 'u-y', agentPageId: null },
        { id: 'a3', taskId: 't1', userId: null, agentPageId: 'ag-1', agentPage: { id: 'ag-1', title: null, type: 'AI_CHAT' } },
        { id: 'a4', taskId: 't1', userId: null, agentPageId: 'ag-2' },
        { id: 'a5', taskId: 't1', userId: null, agentPageId: null },
      ],
    });

    assert({
      given: 'assignee rows without a name, without a relation, or with neither id',
      should: 'keep the ones with an id under an empty name and drop the empty row',
      actual: assigneesOf(item),
      expected: [
        { type: 'user', id: 'u-x', name: '' },
        { type: 'user', id: 'u-y', name: '' },
        { type: 'agent', id: 'ag-1', name: '' },
        { type: 'agent', id: 'ag-2', name: '' },
      ],
    });
  });

  test('legacy single assignee', () => {
    const item = taskItem('t1', {
      assignees: [],
      assigneeId: 'u-ada',
      assignee: { id: 'u-ada', name: 'Ada', image: null },
      assigneeAgentId: 'ag-1',
      assigneeAgent: { id: 'ag-1', title: 'Planner', type: 'AI_CHAT' },
    });

    assert({
      given: 'a row from before task_assignees, with only the legacy fields',
      should: 'read the legacy person and agent',
      actual: assigneesOf(item),
      expected: [
        { type: 'user', id: 'u-ada', name: 'Ada' },
        { type: 'agent', id: 'ag-1', name: 'Planner' },
      ],
    });
  });

  test('legacy ids without relations', () => {
    const item = taskItem('t1', { assignees: undefined, assigneeId: 'u-ada', assigneeAgentId: null });

    assert({
      given: 'a legacy assignee id with no relation and no junction rows',
      should: 'keep the id under an empty name',
      actual: assigneesOf(item),
      expected: [{ type: 'user', id: 'u-ada', name: '' }],
    });
  });
});

describe('taskFromItem()', () => {
  test('mapping', () => {
    const item = taskItem('t1', {
      title: 'Ship it',
      status: 'in_progress',
      priority: 'high',
      position: 3,
      dueDate: '2026-10-09T00:00:00.000Z',
      hasContent: true,
      subTaskCount: 4,
      subTaskCompletedCount: 1,
      updatedAt: '2026-10-02T00:00:00.000Z',
    });

    assert({
      given: 'an enriched task from GET /tasks',
      should: 'carry its fields, counts and page, with subtasks not yet loaded',
      actual: taskFromItem(item),
      expected: {
        id: 't1',
        pageId: 'page-t1',
        title: 'Ship it',
        status: 'in_progress',
        priority: 'high',
        dueDate: '2026-10-09T00:00:00.000Z',
        completedAt: null,
        assignees: [],
        position: 3,
        hasContent: true,
        subTaskCount: 4,
        subTaskCompletedCount: 1,
        updatedAt: '2026-10-02T00:00:00.000Z',
        subtasks: null,
      },
    });
  });

  test('a create response', () => {
    const item = taskItem('t1', {
      hasContent: undefined,
      subTaskCount: undefined,
      subTaskCompletedCount: undefined,
    });
    const mapped = taskFromItem(item);

    assert({
      given: 'a POST /tasks answer, which carries no derived counts',
      should: 'read a new task as empty: no content, no subtasks',
      actual: [mapped.hasContent, mapped.subTaskCount, mapped.subTaskCompletedCount],
      expected: [false, 0, 0],
    });
  });
});

describe('taskListFrom()', () => {
  test('mapping', () => {
    const body = taskListResponse([taskItem('t1'), taskItem('t2')], { hasMore: true });

    assert({
      given: 'a GET /tasks answer for a list page',
      should: 'build that page’s list with its own statuses and tasks',
      actual: taskListFrom('list-1', 'Launch', body),
      expected: {
        pageId: 'list-1',
        title: 'Launch',
        statuses: statusesFrom(seededConfigs),
        tasks: [taskFromItem(taskItem('t1')), taskFromItem(taskItem('t2'))],
        hasMore: true,
      },
    });
  });
});

describe('driveTaskLists()', () => {
  test('filtering', () => {
    const pages = [
      { id: 'doc', title: 'Notes', type: 'DOCUMENT', hasChildren: false, isTaskLinked: false },
      { id: 'list-a', title: 'Launch', type: 'TASK_LIST', hasChildren: true, isTaskLinked: false },
      { id: 'task-1', title: 'A task', type: 'TASK_LIST', hasChildren: false, isTaskLinked: true },
      { id: 'list-b', title: 'Backlog', type: 'TASK_LIST', hasChildren: false, isTaskLinked: false },
    ];

    assert({
      given: 'every page of a drive',
      should: 'list the TASK_LIST pages people made, not tasks’ own pages or other types',
      actual: driveTaskLists({ mode: 'ls', pages }),
      expected: [
        { pageId: 'list-a', title: 'Launch' },
        { pageId: 'list-b', title: 'Backlog' },
      ],
    });
  });
});
