import { describe, it, expect } from 'vitest';
import { isFirstInGroup } from '../grouping';

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
});
