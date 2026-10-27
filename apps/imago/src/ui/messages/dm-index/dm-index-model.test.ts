import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { messageablePeopleFrom, personNameOf } from './dm-index-model';

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
