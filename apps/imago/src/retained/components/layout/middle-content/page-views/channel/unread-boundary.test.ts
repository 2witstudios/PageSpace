import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { unreadBoundary, type UnreadCandidate } from './unread-boundary';

const at = (id: string, time: string, extra: Partial<UnreadCandidate> = {}): UnreadCandidate => ({
  id,
  createdAt: time,
  userId: 'them',
  ...extra,
});

const READ = '2026-10-05T09:00:00.000Z';

describe('unreadBoundary', () => {
  test('places the divider before the first message after lastReadAt and counts all of them', () => {
    const messages = [
      at('old', '2026-10-05T08:00:00.000Z'),
      at('new1', '2026-10-05T09:30:00.000Z'),
      at('new2', '2026-10-05T09:45:00.000Z'),
    ];
    assert({
      given: 'messages before and after the watermark',
      should: 'mark the first unread message and count the unread ones',
      actual: unreadBoundary(messages, READ, 'me'),
      expected: { id: 'new1', count: 2 },
    });
  });

  test('ignores the viewer’s own messages when counting', () => {
    const messages = [
      at('mine', '2026-10-05T09:10:00.000Z', { userId: 'me' }),
      at('theirs', '2026-10-05T09:20:00.000Z'),
    ];
    assert({
      given: 'an own message after the watermark',
      should: 'start the divider at the first message from someone else',
      actual: unreadBoundary(messages, READ, 'me'),
      expected: { id: 'theirs', count: 1 },
    });
  });

  test('skips optimistic pending rows but counts agent posts', () => {
    const messages = [
      at('temp-1', '2026-10-05T09:50:00.000Z', { userId: 'me' }),
      at('agent', '2026-10-05T09:55:00.000Z', { userId: null }),
    ];
    assert({
      given: 'a pending own post and an agent post after the watermark',
      should: 'count only the saved agent post',
      actual: unreadBoundary(messages, READ, 'me'),
      expected: { id: 'agent', count: 1 },
    });
  });

  test('is null when nothing arrived after lastReadAt', () => {
    assert({
      given: 'every message read',
      should: 'show no divider',
      actual: unreadBoundary([at('a', '2026-10-05T08:00:00.000Z')], READ, 'me'),
      expected: null,
    });
  });

  test('is null for a channel never read, so a first visit shows no divider', () => {
    assert({
      given: 'lastReadAt is null',
      should: 'show no divider',
      actual: unreadBoundary([at('a', '2026-10-05T08:00:00.000Z')], null, 'me'),
      expected: null,
    });
  });
});
