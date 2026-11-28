import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { CONNECTIONS_GROUP, SHARED_DRIVE_GROUP, groupPeople, sourceLabelOf, type MessageablePerson } from './dm-people';

const person = (over: Partial<MessageablePerson> & Pick<MessageablePerson, 'id' | 'source'>): MessageablePerson => ({
  name: null,
  email: `${over.id}@example.com`,
  image: null,
  username: null,
  displayName: null,
  bio: null,
  avatarUrl: null,
  sharedDriveCount: 0,
  ...over,
});

const people = [
  person({ id: 'p1', displayName: 'Priya Shah', username: 'priya', source: 'drive', sharedDriveCount: 2 }),
  person({ id: 'p2', displayName: 'Dana Whitfield', username: 'dana', source: 'connection' }),
  person({ id: 'p3', name: 'Marcus Lee', username: 'marcus', source: 'drive', sharedDriveCount: 1 }),
];

describe('groupPeople()', () => {
  test('an empty search', () => {
    assert({
      given: 'people who share a drive and connections, and no search',
      should: 'group drive sharers first, then connections',
      actual: groupPeople(people, '').map((g) => [g.title, g.people.map((p) => p.id)]),
      expected: [
        [SHARED_DRIVE_GROUP, ['p1', 'p3']],
        [CONNECTIONS_GROUP, ['p2']],
      ],
    });
  });

  test('a search by @username', () => {
    assert({
      given: 'a search for @dana',
      should: 'match the username and drop empty groups',
      actual: groupPeople(people, '@Dana').map((g) => [g.title, g.people.map((p) => p.id)]),
      expected: [[CONNECTIONS_GROUP, ['p2']]],
    });
  });

  test('a search with no match', () => {
    assert({
      given: 'a search that matches nobody',
      should: 'return no groups',
      actual: groupPeople(people, 'zzz'),
      expected: [],
    });
  });
});

describe('sourceLabelOf()', () => {
  test('a connection and drive sharers', () => {
    assert({
      given: 'a connection, a one-drive sharer and a two-drive sharer',
      should: 'name the source in the picker wording',
      actual: [
        sourceLabelOf(person({ id: 'a', source: 'connection' })),
        sourceLabelOf(person({ id: 'b', source: 'drive', sharedDriveCount: 1 })),
        sourceLabelOf(person({ id: 'c', source: 'drive', sharedDriveCount: 2 })),
      ],
      expected: ['Connection', '1 shared drive', '2 shared drives'],
    });
  });
});
