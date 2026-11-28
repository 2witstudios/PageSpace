import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { Assignee, TaskTriggerResponse } from '../task-model/task';
import { automationRows } from './task-automations';

const trigger = (overrides: Partial<TaskTriggerResponse> = {}): TaskTriggerResponse => ({
  id: 't1',
  triggerType: 'due_date',
  nextRunAt: '2026-11-14T08:00:00.000Z',
  lastFiredAt: null,
  lastFireError: null,
  isEnabled: true,
  agentPageId: 'ag-1',
  prompt: 'Remind the launch team',
  ...overrides,
});

const agents: readonly Assignee[] = [
  { type: 'user', id: 'ag-1', name: 'Dana' },
  { type: 'agent', id: 'ag-1', name: 'Launch Agent' },
];

describe('automationRows', () => {
  test('a due trigger, scheduled and run by a named agent', () => {
    const [row] = automationRows([trigger()], agents);
    assert({
      given: 'a due trigger on an agent the drive names, scheduled for 14 November',
      should: 'show the agent by name, its enabled state and when it next runs',
      actual: row === undefined ? undefined : { kind: row.kind, enabled: row.enabled, agent: row.agent, scheduled: row.nextRun !== null },
      expected: { kind: 'due_date', enabled: true, agent: 'Launch Agent', scheduled: true },
    });
  });

  test('a completion trigger on an agent the drive does not name', () => {
    const rows = automationRows([trigger({ triggerType: 'completion', nextRunAt: null, agentPageId: 'gone', isEnabled: false })], agents);
    assert({
      given: 'a completion trigger on an agent that is not among the drive’s',
      should: 'keep the row with no agent name and no schedule, and show it disabled',
      actual: rows,
      expected: [{ id: 't1', kind: 'completion', enabled: false, agent: null, nextRun: null }],
    });
  });

  test('no triggers', () => {
    assert({
      given: 'a task with no triggers',
      should: 'have no rows, so the section offers only its completion placeholder',
      actual: automationRows([], agents),
      expected: [],
    });
  });
});
