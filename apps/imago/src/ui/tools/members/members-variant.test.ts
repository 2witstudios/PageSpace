import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { membersVariantFor } from './members-variant';

describe('membersVariantFor', () => {
  test('reads the pane body from the route', () => {
    assert({
      given: 'the Members routes of a drive',
      should: 'pick the overview, the invite form or the member the URL names',
      actual: [
        membersVariantFor('/d1/members'),
        membersVariantFor('/d1/members/invite'),
        membersVariantFor('/d1/members/u1'),
        membersVariantFor('/d1/calendar'),
        membersVariantFor(null),
      ],
      expected: [
        { kind: 'overview' },
        { kind: 'invite' },
        { kind: 'profile', userId: 'u1' },
        { kind: 'overview' },
        { kind: 'overview' },
      ],
    });
  });
});
