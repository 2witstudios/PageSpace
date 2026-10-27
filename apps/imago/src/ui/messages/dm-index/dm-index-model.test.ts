import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { DirectThread } from '../message-model/message';
import { filterThreads, matchesFilter, messageablePeopleFrom, personNameOf } from './dm-index-model';

const thread = (name: string, username: string | null): DirectThread => ({
  kind: 'dm',
  id: `m-${name}`,
  name,
  username,
  avatarUrl: null,
  otherUserId: null,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastReadAt: null,
  unreadCount: 0,
});

describe('matchesFilter()', () => {
  test('name or username, case-insensitively, ignoring surrounding space', () => {
    const dana = thread('Dana Lee', 'dana');
    assert({
      given: 'a conversation with a name and a username',
      should: 'match a query in either, regardless of case and surrounding space',
      actual: [
        matchesFilter(dana, ''),
        matchesFilter(dana, '  '),
        matchesFilter(dana, 'LEE'),
        matchesFilter(dana, ' dan '),
        matchesFilter(dana, 'marcus'),
      ],
      expected: [true, true, true, true, false],
    });
  });

  test('a missing username', () => {
    assert({
      given: 'a conversation with no username',
      should: 'match on the name only',
      actual: [matchesFilter(thread('Sam', null), 'sam'), matchesFilter(thread('Sam', null), 'null')],
      expected: [true, false],
    });
  });
});

describe('filterThreads()', () => {
  test('narrows the rows and keeps their order', () => {
    const rows = [thread('Dana', 'dana'), thread('Sam', 'sam'), thread('Priya', 'priya'), thread('Danielle', 'dani')];
    assert({
      given: 'conversations and a filter that matches two of them by name or username',
      should: 'keep only those two, in the order they came',
      actual: filterThreads(rows, 'da').map((row) => row.name),
      expected: ['Dana', 'Danielle'],
    });
  });
});

describe('personNameOf() and messageablePeopleFrom()', () => {
  test('the name a person is drawn with', () => {
    assert({
      given: 'people with and without display names, names and usernames',
      should: 'prefer the display name, then the name, then the username, then a fallback',
      actual: [
        personNameOf({ displayName: 'Dana L', name: 'Dana', username: 'dana' }),
        personNameOf({ displayName: null, name: 'Dana', username: 'dana' }),
        personNameOf({ displayName: null, name: null, username: 'dana' }),
        personNameOf({ displayName: null, name: null, username: null }),
      ],
      expected: ['Dana L', 'Dana', 'dana', 'Unknown user'],
    });
  });

  test('the messageable people, in the order the server gave them', () => {
    assert({
      given: 'two messageable users, one with only an image',
      should: 'draw each with its name, username and avatar (the profile avatar, else the account image)',
      actual: messageablePeopleFrom([
        { id: 'u1', name: 'Priya', username: 'priya', displayName: null, image: null, avatarUrl: 'https://img/p.png' },
        { id: 'u2', name: null, username: 'sam', displayName: null, image: 'https://img/s.png', avatarUrl: null },
      ]),
      expected: [
        { id: 'u1', name: 'Priya', username: 'priya', avatarUrl: 'https://img/p.png' },
        { id: 'u2', name: 'sam', username: 'sam', avatarUrl: 'https://img/s.png' },
      ],
    });
  });
});
