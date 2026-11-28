import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { unreadMarkerOf } from './unread-divider';

const row = (id: string, senderId: string, isRead: boolean) => ({ id, senderId, isRead });

describe('unreadMarkerOf()', () => {
  test('a conversation with unread incoming messages', () => {
    const marker = unreadMarkerOf(
      [row('a', 'me', true), row('b', 'dana', true), row('c', 'dana', false), row('d', 'dana', false)],
      'me',
    );

    assert({
      given: 'two unread incoming messages after a read one',
      should: 'mark the first unread one and count both',
      actual: marker,
      expected: { messageId: 'c', count: 2 },
    });
  });

  test('a conversation with nothing unread', () => {
    assert({
      given: 'only read messages',
      should: 'return no marker',
      actual: unreadMarkerOf([row('a', 'dana', true), row('b', 'me', false)], 'me'),
      expected: null,
    });
  });

  test('the viewer own unread messages', () => {
    assert({
      given: 'an unread message the viewer sent',
      should: 'not count it as new',
      actual: unreadMarkerOf([row('a', 'me', false)], 'me'),
      expected: null,
    });
  });

  test('a viewer not yet known', () => {
    assert({
      given: 'unread incoming messages but no viewer id yet',
      should: 'return no marker rather than count every message',
      actual: unreadMarkerOf([row('a', 'dana', false)], undefined),
      expected: null,
    });
  });
});
