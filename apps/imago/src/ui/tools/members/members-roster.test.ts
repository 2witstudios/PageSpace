import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { everyoneCount, memberGroups, partitionMembers, type RosterCounts } from './members-roster';

const roster: RosterCounts = { people: 4, guests: 1, agents: 3, apps: 1, pendingInvites: 1, inviteLinks: 1 };

describe('partitionMembers()', () => {
  test('page-link GUEST rows apart from people', () => {
    const { people, guests } = partitionMembers([
      { role: 'OWNER' },
      { role: 'MEMBER' },
      { role: 'GUEST' },
      { role: 'ADMIN' },
    ]);
    assert({
      given: 'members with GUEST rows among them',
      should: 'list the GUEST rows as guests and the rest as people',
      actual: [people.map((m) => m.role), guests.map((m) => m.role)],
      expected: [['OWNER', 'MEMBER', 'ADMIN'], ['GUEST']],
    });
  });
});

describe('everyoneCount()', () => {
  test('sums people, guests, agents and apps', () => {
    assert({
      given: 'a roster with people, guests, agents and apps',
      should: 'count everyone who has access to the drive',
      actual: everyoneCount(roster),
      expected: 9,
    });
  });
});

describe('memberGroups()', () => {
  test('the rows in board order, with live counts and their section anchors', () => {
    assert({
      given: 'a loaded roster',
      should: 'list Everyone to Invite links with each count and the section it jumps to',
      actual: memberGroups(roster).map(({ label, count, anchor }) => [label, count, anchor]),
      expected: [
        ['Everyone', 9, '#everyone'],
        ['People', 4, '#people'],
        ['Guests', 1, '#page-link-guests'],
        ['Agents', 3, '#agents'],
        ['Apps', 1, '#apps'],
        ['Pending invites', 1, '#pending'],
        ['Invite links', 1, '#links'],
      ],
    });
  });

  test('no counts while the roster loads', () => {
    assert({
      given: 'a roster that has not loaded',
      should: 'show every group without a count rather than a guessed one',
      actual: memberGroups(undefined).map((group) => group.count),
      expected: [undefined, undefined, undefined, undefined, undefined, undefined, undefined],
    });
  });

  test('invite links hidden from the viewer', () => {
    assert({
      given: 'a roster the viewer may not see the invite links of',
      should: 'leave the Invite links count undefined',
      actual: memberGroups({ ...roster, inviteLinks: undefined }).find((group) => group.id === 'links')?.count,
      expected: undefined,
    });
  });
});
