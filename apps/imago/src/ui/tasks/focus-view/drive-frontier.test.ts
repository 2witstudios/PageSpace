import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { seededConfigs, taskItem } from '../task-model/fixtures';
import type { DriveTaskResponse, DriveTasksResponse } from '../task-model/task';
import { driveFrontier } from './focus-view';

const row = (id: string, list: string, overrides: Partial<DriveTaskResponse> = {}): DriveTaskResponse => ({
  ...taskItem(id, { title: `Task ${id}` }),
  driveId: 'd1',
  taskListPageId: list,
  taskListPageTitle: list === 'l1' ? 'Launch' : 'Hiring',
  statusGroup: 'todo',
  statusLabel: 'To Do',
  statusColor: '',
  ...overrides,
});

const response = (tasks: readonly DriveTaskResponse[]): DriveTasksResponse => ({
  tasks,
  statusConfigsByTaskList: { l1: seededConfigs, l2: seededConfigs },
  pagination: { total: tasks.length, limit: 100, offset: 0, hasMore: false },
});

describe('driveFrontier', () => {
  test('leaves by list, soonest first', () => {
    const groups = driveFrontier(
      response([
        row('a', 'l1', { dueDate: '2026-10-30T00:00:00.000Z' }),
        row('p', 'l1', { subTaskCount: 2 }),
        row('b', 'l2', { dueDate: '2026-10-20T00:00:00.000Z' }),
        row('c', 'l1'),
        row('d', 'l2', { statusGroup: 'done' }),
      ]),
    );
    assert({
      given: "the viewer's open tasks across two lists, one a parent and one done",
      should: 'group the open leaves by list, the list due soonest first, each with its own statuses',
      actual: groups.map((group) => [group.heading, group.tasks.map((task) => task.id), group.list.statuses.length]),
      expected: [
        ['Hiring', ['b'], 4],
        ['Launch', ['a', 'c'], 4],
      ],
    });
  });
});
