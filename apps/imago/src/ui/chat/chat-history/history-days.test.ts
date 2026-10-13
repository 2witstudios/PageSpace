import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { agentConversation } from '../chat-model/fixtures';
import { historyDayLabel, historyDays, untilNextDay } from './history-days';

// Days are the viewer's, not UTC's: every case runs in a zone far from UTC,
// where a UTC calendar would file the evening's chats under tomorrow.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  process.env.TZ = zone;
});

/** 2026-10-05 08:30 in Los Angeles (PDT, UTC−7). */
const NOW = new Date('2026-10-05T15:30:00.000Z');

const at = (id: string, updatedAt: string) => agentConversation(id, { updatedAt });

describe('historyDayLabel()', () => {
  test('today and yesterday by the local calendar', () => {
    assert({
      given: 'times just after and just before local midnight, which UTC files under other days',
      should: 'name the local day: Today, Yesterday, then the date',
      actual: [
        // 00:05 PDT on Oct 5 is 07:05 UTC: today.
        historyDayLabel('2026-10-05T07:05:00.000Z', NOW),
        // 23:55 PDT on Oct 4 is 06:55 UTC on Oct 5: yesterday, not today.
        historyDayLabel('2026-10-05T06:55:00.000Z', NOW),
        // 23:55 PDT on Oct 3 is 06:55 UTC on Oct 4: a date, not yesterday.
        historyDayLabel('2026-10-04T06:55:00.000Z', NOW),
      ],
      expected: ['Today', 'Yesterday', 'Oct 3'],
    });
  });

  test('a date in another year carries the year', () => {
    assert({
      given: 'a time last December',
      should: 'name the month, day and year',
      actual: historyDayLabel('2025-12-31T20:00:00.000Z', NOW),
      expected: 'Dec 31, 2025',
    });
  });

  test('across a daylight-saving change', () => {
    // Nov 1 2026 ends PDT; "now" is Nov 2 09:00 PST (UTC−8).
    const after = new Date('2026-11-02T17:00:00.000Z');
    assert({
      given: 'yesterday spanning 25 hours and the day before it',
      should: 'still count calendar days',
      actual: [
        historyDayLabel('2026-11-01T08:30:00.000Z', after), // 01:30 PDT Nov 1
        historyDayLabel('2026-10-31T19:00:00.000Z', after), // 12:00 PDT Oct 31
      ],
      expected: ['Yesterday', 'Oct 31'],
    });
  });

  test('a time ahead of the clock', () => {
    assert({
      given: 'a conversation stamped later today than the viewer’s clock reads',
      should: 'still file it under Today',
      actual: historyDayLabel('2026-10-06T05:00:00.000Z', NOW), // 22:00 PDT Oct 5
      expected: 'Today',
    });
  });
});

describe('untilNextDay()', () => {
  test('to the next local midnight', () => {
    assert({
      given: '08:30 local, 23:59:30 local, and the night daylight saving ends (a 25-hour day)',
      should: 'count to the next local midnight, not the next UTC one',
      actual: [
        untilNextDay(NOW),
        untilNextDay(new Date('2026-10-06T06:59:30.000Z')),
        untilNextDay(new Date('2026-11-01T07:00:00.000Z')), // 00:00 PDT Nov 1 → 00:00 PST Nov 2
      ],
      expected: [15.5 * 3_600_000, 30_000, 25 * 3_600_000],
    });
  });
});

describe('historyDays()', () => {
  test('groups newest first, in sentence case', () => {
    const days = historyDays(
      [
        at('c4', '2026-10-05T15:00:00.000Z'),
        at('c3', '2026-10-05T07:05:00.000Z'),
        at('c2', '2026-10-05T06:55:00.000Z'),
        at('c1', '2026-09-18T12:00:00.000Z'),
        at('c0', '2026-09-18T11:00:00.000Z'),
      ],
      NOW,
    );
    assert({
      given: 'conversations most recent first, two of them either side of local midnight',
      should: 'file each under its local day, in the order given',
      actual: days.map(({ label, conversations }) => [label, conversations.map((entry) => entry.id)]),
      expected: [
        ['Today', ['c4', 'c3']],
        ['Yesterday', ['c2']],
        ['Sep 18', ['c1', 'c0']],
      ],
    });
  });

  test('no conversations', () => {
    assert({
      given: 'an agent with no conversations',
      should: 'make no groups',
      actual: historyDays([], NOW),
      expected: [],
    });
  });

  test('an unreadable time', () => {
    assert({
      given: 'a conversation whose time does not parse',
      should: 'file it under Earlier rather than a broken date',
      actual: historyDays([at('c1', 'not a time')], NOW).map(({ label }) => label),
      expected: ['Earlier'],
    });
  });
});
