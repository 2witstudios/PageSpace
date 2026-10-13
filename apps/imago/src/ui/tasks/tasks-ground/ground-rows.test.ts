import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { taskItem } from '../task-model/fixtures';
import type { DriveTaskResponse } from '../task-model/task';
import { taskPaths } from '../task-api/task-api';
import { groundSections, listCount } from './ground-rows';

// 2026-10-12 is a Monday: this week runs through Sunday the 18th.
const TODAY = '2026-10-12';

const drive = (id: string, extra: Partial<DriveTaskResponse> = {}): DriveTaskResponse => ({
  ...taskItem(id),
  driveId: 'd1',
  taskListPageId: 'l1',
  taskListPageTitle: 'Launch Tasks',
  statusGroup: 'todo',
  statusLabel: 'To Do',
  statusColor: '',
  ...extra,
});

describe('groundSections()', () => {
  test('sections the tasks by when they fall due, by the viewer’s own day', () => {
    const sections = groundSections(
      [
        drive('late', { dueDate: '2026-10-09T12:00:00' }),
        drive('week', { dueDate: '2026-10-14T12:00:00' }),
        drive('later', { dueDate: '2026-11-21T12:00:00' }),
        drive('none'),
        drive('doneLate', { statusGroup: 'done', dueDate: '2026-10-01T12:00:00' }),
      ],
      TODAY,
    );
    assert({
      given: 'an overdue task, one due this week, one due later, one with no date and one done but past due',
      should: 'put the overdue task in Overdue, the week one in Due this week, and the rest in Later',
      actual: sections.map((section) => [section.name, section.rows.map((row) => row.id)]),
      expected: [
        ['Overdue', ['late']],
        ['Due this week', ['week']],
        ['Later', ['later', 'none', 'doneLate']],
      ],
    });
  });

  test('a row carries its list, status, people and due tone', () => {
    const [row] = groundSections(
      [
        drive('t', {
          dueDate: '2026-10-09T12:00:00',
          statusGroup: 'in_progress',
          statusLabel: 'Blocked',
          priority: 'high',
          assignees: [
            { id: 'ta', taskId: 't', userId: 'u1', agentPageId: null, user: { id: 'u1', name: 'Jono', image: null } },
            { id: 'tb', taskId: 't', userId: null, agentPageId: 'a1', agentPage: { id: 'a1', title: 'Launch Agent', type: 'AI_CHAT' } },
          ],
        }),
      ],
      TODAY,
    ).flatMap((section) => section.rows);
    assert({
      given: 'an overdue high-priority task under Blocked, with a person and an agent on it',
      should: 'show its list, status label, priority, both assignees and an overdue due tone',
      actual: {
        list: row?.list,
        status: row?.statusLabel,
        priority: row?.priority,
        people: row?.people.map((person) => [person.type, person.name]),
        due: row?.due,
        tone: row?.dueTone,
        done: row?.done,
      },
      expected: {
        list: 'Launch Tasks',
        status: 'Blocked',
        priority: 'high',
        people: [
          ['user', 'Jono'],
          ['agent', 'Launch Agent'],
        ],
        due: 'Oct 9',
        tone: 'overdue',
        done: false,
      },
    });
  });

  test('listCount()', () => {
    assert({
      given: 'three tasks in two lists',
      should: 'count the distinct lists',
      actual: listCount([drive('a'), drive('b', { taskListPageId: 'l2' }), drive('c')]),
      expected: 2,
    });
  });

  test('the requests the pane and the ground make', () => {
    assert({
      given: 'a view count, and the ground’s active tasks due overdue',
      should: 'ask GET /api/tasks for the drive with one row, and with the status group and due window',
      actual: [
        taskPaths.driveTasks({ driveId: 'd1', limit: 1 }),
        taskPaths.driveTasks({ driveId: 'd1', limit: 100, statusGroup: 'active', dueDateFilter: 'overdue' }),
      ],
      expected: [
        '/api/tasks?context=drive&driveId=d1&limit=1',
        '/api/tasks?context=drive&driveId=d1&limit=100&statusGroup=active&dueDateFilter=overdue',
      ],
    });
  });
});
