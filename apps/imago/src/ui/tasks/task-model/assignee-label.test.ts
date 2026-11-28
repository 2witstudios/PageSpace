import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { assigneeLabel } from './assignee-label';

describe('assigneeLabel()', () => {
  test('a person', () => {
    assert({
      given: 'a human, and a person with no account type',
      should: 'return the name unchanged, byte for byte',
      actual: [
        assigneeLabel({ type: 'user', id: 'u', name: '  Ada ', accountType: 'human' }),
        assigneeLabel({ type: 'user', id: 'u', name: 'Ada' }),
      ],
      expected: ['  Ada ', 'Ada'],
    });
  });

  test('an agent account', () => {
    assert({
      given: 'a person-type assignee whose account is an AI agent',
      should: 'mark the name in plain text',
      actual: assigneeLabel({ type: 'user', id: 'a', name: 'Helper', accountType: 'agent' }),
      expected: 'Helper (AI agent)',
    });
  });

  test('an agent page', () => {
    assert({
      given: 'an agent page (never an account)',
      should: 'leave its title unchanged',
      actual: assigneeLabel({ type: 'agent', id: 'p', name: 'Planner', accountType: 'agent' }),
      expected: 'Planner',
    });
  });
});
