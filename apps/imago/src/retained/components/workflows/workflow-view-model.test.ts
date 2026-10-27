import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { hasSchedule, lastRunLabel, lastRunTone, relativeRunText, stepViews } from './workflow-view-model';
import type { WorkflowLastRun } from './types';

const run = (status: WorkflowLastRun['status']): WorkflowLastRun => ({
  status,
  startedAt: '2026-10-12T08:00:00.000Z',
  endedAt: null,
  error: null,
  durationMs: null,
});

describe('lastRunLabel() and lastRunTone()', () => {
  test('a workflow that never ran, and each run status', () => {
    assert({
      given: 'no last run and each run status',
      should: 'name the badge and pick its colour family',
      actual: [
        lastRunLabel(null),
        lastRunTone(null),
        lastRunLabel(run('success')),
        lastRunTone(run('success')),
        lastRunLabel(run('error')),
        lastRunTone(run('error')),
        lastRunLabel(run('running')),
        lastRunTone(run('running')),
        lastRunLabel(run('cancelled')),
        lastRunTone(run('cancelled')),
      ],
      expected: [
        'Never run', 'neutral',
        'Success', 'success',
        'Error', 'danger',
        'Running', 'running',
        'Cancelled', 'neutral',
      ],
    });
  });
});

describe('relativeRunText()', () => {
  const now = new Date('2026-10-12T12:00:00.000Z');

  test('hours, minutes and days from now', () => {
    assert({
      given: 'next runs 22 hours, 5 minutes and 3 days away',
      should: 'read each in its natural unit',
      actual: [
        relativeRunText(new Date('2026-10-13T10:00:00.000Z'), now),
        relativeRunText(new Date('2026-10-12T12:05:00.000Z'), now),
        relativeRunText(new Date('2026-10-15T12:00:00.000Z'), now),
      ],
      expected: ['in 22 hours', 'in 5 minutes', 'in 3 days'],
    });
  });

  test('an instant that is now', () => {
    assert({
      given: 'a run due at the current moment',
      should: 'read "just now"',
      actual: relativeRunText(now, now),
      expected: 'just now',
    });
  });
});

describe('stepViews()', () => {
  test('tool and AI steps, with the agent name falling back to the workflow agent', () => {
    assert({
      given: 'a tool step, an AI step naming an agent and an AI step with no agent of its own',
      should: 'number them from 1, label the kind and name the agent when one is known',
      actual: stepViews(
        [
          { kind: 'tool', toolName: 'list_pages', args: { driveId: 'd1' } },
          { kind: 'ai', prompt: 'Summarize', agentPageId: 'a1' },
          { kind: 'ai', prompt: 'Post it' },
        ],
        new Map([['a1', 'Launch Agent'], ['a2', 'Digest Agent']]),
        'a2',
      ),
      expected: [
        { n: 1, kind: 'Tool', title: 'list_pages', detail: '{"driveId":"d1"}' },
        { n: 2, kind: 'AI', title: 'Launch Agent', detail: 'Summarize' },
        { n: 3, kind: 'AI', title: 'Digest Agent', detail: 'Post it' },
      ],
    });
  });

  test('an AI step whose agent is unknown', () => {
    assert({
      given: 'an AI step with no agent and no workflow agent',
      should: 'title it generically rather than invent an agent name',
      actual: stepViews([{ kind: 'ai', prompt: 'Do it' }], new Map(), null),
      expected: [{ n: 1, kind: 'AI', title: 'AI step', detail: 'Do it' }],
    });
  });
});

describe('hasSchedule()', () => {
  test('a cron expression, blank or missing', () => {
    assert({
      given: 'a cron expression, a blank one and none',
      should: 'show the schedule card only for a real expression',
      actual: [
        hasSchedule({ cronExpression: '0 8 * * 1-5' }),
        hasSchedule({ cronExpression: '  ' }),
        hasSchedule({ cronExpression: null }),
      ],
      expected: [true, false, false],
    });
  });
});
