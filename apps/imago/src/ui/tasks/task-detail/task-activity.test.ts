import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { ActivityResponse } from '../task-model/task';
import { actionOf, activityRows, setByImago, timeAgo } from './task-activity';

const NOW = new Date('2026-10-12T12:00:00.000Z');

const activity = (overrides: Partial<ActivityResponse> = {}): ActivityResponse => ({
  id: 'a1',
  timestamp: '2026-10-12T11:58:00.000Z',
  operation: 'update',
  actorDisplayName: 'Dana',
  isAiGenerated: false,
  updatedFields: null,
  user: null,
  ...overrides,
});

describe('timeAgo', () => {
  test('minutes, hours, yesterday, then the day', () => {
    assert({
      given: 'activity two minutes, three hours, thirty hours and nine days old',
      should: 'read them as 2m, 3h, Yesterday and the day',
      actual: [
        timeAgo('2026-10-12T11:58:00.000Z', NOW),
        timeAgo('2026-10-12T09:00:00.000Z', NOW),
        timeAgo('2026-10-11T06:00:00.000Z', NOW),
        timeAgo('2026-10-03T12:00:00.000Z', NOW),
      ],
      expected: ['2m', '3h', 'Yesterday', 'Oct 3'],
    });
  });
});

describe('actionOf', () => {
  test('names the field a change touched, else the operation', () => {
    assert({
      given: 'changes to the due date, a status, and a create, a trash and an unknown operation',
      should: 'say what each did in the board’s words',
      actual: [
        actionOf({ operation: 'update', updatedFields: ['dueDate'] }),
        actionOf({ operation: 'update', updatedFields: ['status', 'title'] }),
        actionOf({ operation: 'create', updatedFields: null }),
        actionOf({ operation: 'trash', updatedFields: null }),
        actionOf({ operation: 'rollback', updatedFields: ['notes'] }),
      ],
      expected: ['set due date', 'moved status', 'created this task', 'moved to trash', 'rollback'],
    });
  });
});

describe('activityRows', () => {
  test('marks Imago’s work as Imago and names everyone else', () => {
    assert({
      given: 'a change by Imago and one by Dana, two minutes and two hours old',
      should: 'list Imago as the actor of the AI change, the person’s name otherwise, with how long ago',
      actual: activityRows(
        [
          activity({ id: 'ai', isAiGenerated: true, actorDisplayName: 'Planner', updatedFields: ['dueDate'] }),
          activity({ id: 'h', timestamp: '2026-10-12T10:00:00.000Z', operation: 'create' }),
        ],
        NOW,
      ),
      expected: [
        { id: 'ai', actor: 'Imago', action: 'set due date', time: '2m', byImago: true },
        { id: 'h', actor: 'Dana', action: 'created this task', time: '2h', byImago: false },
      ],
    });
  });
});

describe('setByImago', () => {
  test('reads the latest change to the field', () => {
    assert({
      given: 'Imago set the due date last, and a person set the status after',
      should: 'say the due date was set by Imago, and a person’s status change was not a due-date change',
      actual: [
        setByImago([activity({ isAiGenerated: true, updatedFields: ['dueDate'] })], 'dueDate'),
        setByImago(
          [
            activity({ id: 'p', updatedFields: ['status'] }),
            activity({ id: 'ai', isAiGenerated: true, updatedFields: ['dueDate'] }),
          ],
          'dueDate',
        ),
        setByImago([activity({ updatedFields: ['dueDate'] })], 'dueDate'),
        setByImago([], 'dueDate'),
      ],
      expected: [true, true, false, false],
    });
  });
});
