import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { agoLabel } from './session-label';

describe('agoLabel', () => {
  test('reads minutes, hours and days', () => {
    const now = new Date('2026-10-12T10:42:00.000Z');
    assert({
      given: 'starts 30 seconds, 42 minutes, 3 hours and 2 days ago',
      should: 'read "just now", "42 min ago", "3 h ago" and "2 d ago"',
      actual: [
        agoLabel('2026-10-12T10:41:30.000Z', now),
        agoLabel('2026-10-12T10:00:00.000Z', now),
        agoLabel('2026-10-12T07:42:00.000Z', now),
        agoLabel('2026-10-10T10:42:00.000Z', now),
      ],
      expected: ['just now', '42 min ago', '3 h ago', '2 d ago'],
    });
  });
});
