import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { taskItem, taskListResponse } from '../task-model/fixtures';
import { taskListFrom } from '../task-model/from-api';
import { listMeta } from './list-meta';

// 2026-10-12 is a Monday: this week runs through Sunday the 18th.
const TODAY = '2026-10-12';

const listOf = (items: Parameters<typeof taskItem>[1][]) =>
  taskListFrom('l1', 'Launch', taskListResponse(items.map((extra, i) => taskItem(`t${i}`, { position: i, ...extra }))));

describe('listMeta()', () => {
  test('counts the open tasks that are overdue, due this week, or with an agent', () => {
    const list = listOf([
      { dueDate: '2026-10-09T00:00:00.000Z' },
      { dueDate: '2026-10-15T12:00:00.000Z' },
      { dueDate: '2026-10-30T12:00:00.000Z' },
      {
        assignees: [
          { id: 'ta1', taskId: 't3', userId: null, agentPageId: 'a1', agentPage: { id: 'a1', title: 'Launch Agent', type: 'AI_CHAT' } },
        ],
      },
      { status: 'completed', dueDate: '2026-10-01T12:00:00.000Z' },
    ]);
    assert({
      given: 'a list with one overdue task, one due this week, one far off, one for an agent, and one overdue but done',
      should: 'count only open tasks in each part of the meta line',
      actual: listMeta(list, TODAY),
      expected: '1 overdue · 1 due this week · 1 assigned to agents',
    });
  });

  test('a list with nothing to count', () => {
    assert({
      given: 'a list whose open tasks have no due date and no agent',
      should: 'give no meta line',
      actual: listMeta(listOf([{}, {}]), TODAY),
      expected: '',
    });
  });
});
