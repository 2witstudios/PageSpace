import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isFirstInGroup, formatMessageDate } from '../grouping';

describe('isFirstInGroup', () => {
  const t0 = new Date('2026-05-04T12:00:00Z');
  const t1min = new Date('2026-05-04T12:01:00Z');
  const t6min = new Date('2026-05-04T12:06:00Z');

  it('returns true when there is no previous message', () => {
    expect(isFirstInGroup({ authorKey: 'u1', createdAt: t0 }, undefined)).toBe(true);
  });

  it('returns false for same author within the 5 minute window', () => {
    expect(
      isFirstInGroup(
        { authorKey: 'u1', createdAt: t1min },
        { authorKey: 'u1', createdAt: t0 },
      ),
    ).toBe(false);
  });

  it('returns true for same author past the 5 minute window', () => {
    expect(
      isFirstInGroup(
        { authorKey: 'u1', createdAt: t6min },
        { authorKey: 'u1', createdAt: t0 },
      ),
    ).toBe(true);
  });

  it('returns true when authors differ even within the window', () => {
    expect(
      isFirstInGroup(
        { authorKey: 'u2', createdAt: t1min },
        { authorKey: 'u1', createdAt: t0 },
      ),
    ).toBe(true);
  });

  it('accepts ISO string createdAt values', () => {
    expect(
      isFirstInGroup(
        { authorKey: 'u1', createdAt: t1min.toISOString() },
        { authorKey: 'u1', createdAt: t0.toISOString() },
      ),
    ).toBe(false);
  });

  it('groups when the gap is exactly 5 minutes (boundary is exclusive)', () => {
    const exactlyFive = new Date(t0.getTime() + 5 * 60 * 1000);
    expect(
      isFirstInGroup(
        { authorKey: 'u1', createdAt: exactlyFive },
        { authorKey: 'u1', createdAt: t0 },
      ),
    ).toBe(false);
  });

  it('breaks when the gap is just over 5 minutes', () => {
    const justOver = new Date(t0.getTime() + 5 * 60 * 1000 + 1);
    expect(
      isFirstInGroup(
        { authorKey: 'u1', createdAt: justOver },
        { authorKey: 'u1', createdAt: t0 },
      ),
    ).toBe(true);
  });

  it('breaks the group when either timestamp is unparseable', () => {
    expect(
      isFirstInGroup(
        { authorKey: 'u1', createdAt: 'not a date' },
        { authorKey: 'u1', createdAt: t0 },
      ),
    ).toBe(true);
    expect(
      isFirstInGroup(
        { authorKey: 'u1', createdAt: t0 },
        { authorKey: 'u1', createdAt: 'not a date' },
      ),
    ).toBe(true);
  });

  it('breaks the group when messages cross midnight even within the 5-minute window', () => {
    // 23:59 → 00:00 next day, 1 minute apart — same author
    const beforeMidnight = new Date('2026-05-04T23:59:30Z');
    const afterMidnight = new Date('2026-05-05T00:00:30Z');
    expect(
      isFirstInGroup(
        { authorKey: 'u1', createdAt: afterMidnight },
        { authorKey: 'u1', createdAt: beforeMidnight },
      ),
    ).toBe(true);
  });

  it('does not break the group when messages are on the same calendar day within the window', () => {
    // Same day, same author, 2 minutes apart — should still group
    const a = new Date('2026-05-04T09:00:00Z');
    const b = new Date('2026-05-04T09:02:00Z');
    expect(
      isFirstInGroup(
        { authorKey: 'u1', createdAt: b },
        { authorKey: 'u1', createdAt: a },
      ),
    ).toBe(false);
  });
});

describe('formatMessageDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Today" for a date on the current calendar day', () => {
    vi.setSystemTime(new Date('2026-05-04T15:00:00Z'));
    expect(formatMessageDate(new Date('2026-05-04T08:00:00Z'))).toBe('Today');
  });

  it('returns "Yesterday" for a date on the previous calendar day', () => {
    vi.setSystemTime(new Date('2026-05-04T15:00:00Z'));
    expect(formatMessageDate(new Date('2026-05-03T10:00:00Z'))).toBe('Yesterday');
  });

  it('returns a weekday name for a date within the current week', () => {
    // 2026-05-04 is a Monday; set "now" to Friday 2026-05-08
    vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
    const result = formatMessageDate(new Date('2026-05-05T10:00:00Z'));
    expect(result).toBe('Tuesday');
  });

  it('returns "Month d, yyyy" for dates older than the current week', () => {
    vi.setSystemTime(new Date('2026-05-17T12:00:00Z'));
    expect(formatMessageDate(new Date('2026-05-01T10:00:00Z'))).toBe('May 1, 2026');
  });

  it('accepts ISO string input', () => {
    vi.setSystemTime(new Date('2026-05-04T15:00:00Z'));
    expect(formatMessageDate('2026-05-04T08:00:00Z')).toBe('Today');
  });
});
