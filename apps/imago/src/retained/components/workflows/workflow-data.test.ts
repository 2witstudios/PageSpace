import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { memberName, type DriveMemberProfile } from './workflow-data';

const members: DriveMemberProfile[] = [
  { userId: 'u1', user: { name: 'Jono Account' }, profile: { displayName: 'Jono' } },
  { userId: 'u2', user: { name: 'Sam Okafor' }, profile: { displayName: null } },
  { userId: 'u3', user: null, profile: null },
];

describe('memberName()', () => {
  test('the display name, then the account name, then nothing', () => {
    assert({
      given: 'members with a display name, an account name only, no user, and an unknown id',
      should: 'prefer the display name, fall back to the account name, and say nothing for unknown members',
      actual: [
        memberName(members, 'u1'),
        memberName(members, 'u2'),
        memberName(members, 'u3'),
        memberName(members, 'nobody'),
      ],
      expected: ['Jono', 'Sam Okafor', null, null],
    });
  });
});
