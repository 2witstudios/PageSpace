import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { stageFor } from '../stage/stage';
import { askLabelFor } from './ask-label';

describe('askLabelFor()', () => {
  test('the tools with their own question, and the rest', () => {
    assert({
      given: 'Calendar, Activity, Workflows, Members and a page',
      should: 'ask about the week, what changed, why it failed, then plain Ask',
      actual: ['/d1/calendar', '/d1/activity', '/d1/workflows', '/d1/members', '/abcdefghijklmnopqrstuvwx/files/bcdefghijklmnopqrstuvwxy'].map((path) => askLabelFor(stageFor(path))),
      expected: ['Ask about this week', 'Ask what changed', 'Ask why it failed', 'Ask', 'Ask'],
    });
  });
});
