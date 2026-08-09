import { describe, it, vi } from 'vitest';
import { assert } from './riteway';

/**
 * Candidate Service Tests
 *
 * The candidate table is what makes "corroborated across days" enforceable.
 * These tests pin the two rules that make it work:
 *   - occurrences count DISTINCT DAYS, not sightings
 *   - a claim first seen today cannot be promoted today
 */

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  lt: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));
vi.mock('@pagespace/db/schema/personalization', () => ({
  personalizationCandidates: {
    id: 'id',
    userId: 'userId',
    field: 'field',
    claimKey: 'claimKey',
    occurrences: 'occurrences',
    firstSeenAt: 'firstSeenAt',
    lastSeenAt: 'lastSeenAt',
    promotedAt: 'promotedAt',
    rejectedAt: 'rejectedAt',
  },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

describe('normalizeClaimKey', () => {
  it('collapses casing, punctuation, and whitespace to one key', async () => {
    const { normalizeClaimKey } = await import('../candidate-service');

    assert({
      given: 'the same claim written two ways',
      should: 'produce the same dedupe key so they corroborate each other',
      actual: normalizeClaimKey('Be concise.') === normalizeClaimKey('be  concise'),
      expected: true,
    });
  });

  it('keeps genuinely different claims apart', async () => {
    const { normalizeClaimKey } = await import('../candidate-service');

    assert({
      given: 'two different claims',
      should: 'produce different dedupe keys',
      actual: normalizeClaimKey('Be concise') === normalizeClaimKey('Be verbose'),
      expected: false,
    });
  });
});

describe('shouldIncrementOccurrences', () => {
  it('does not increment for a second sighting on the same UTC day', async () => {
    const { shouldIncrementOccurrences } = await import('../candidate-service');

    const morning = new Date('2026-03-10T08:00:00.000Z');
    const evening = new Date('2026-03-10T23:59:59.000Z');

    assert({
      given: 'a claim already seen earlier the same UTC day',
      should: 'not count as new corroboration',
      actual: shouldIncrementOccurrences(morning, evening),
      expected: false,
    });
  });

  it('increments across a UTC day boundary even minutes apart', async () => {
    const { shouldIncrementOccurrences } = await import('../candidate-service');

    const beforeMidnight = new Date('2026-03-10T23:59:00.000Z');
    const afterMidnight = new Date('2026-03-11T00:01:00.000Z');

    assert({
      given: 'sightings either side of midnight UTC',
      should: 'count as corroboration on a distinct day',
      actual: shouldIncrementOccurrences(beforeMidnight, afterMidnight),
      expected: true,
    });
  });
});

describe('promotionCutoff', () => {
  it('excludes a claim first seen earlier today', async () => {
    const { promotionCutoff } = await import('../candidate-service');

    const now = new Date('2026-03-10T18:00:00.000Z');
    const firstSeenThisMorning = new Date('2026-03-10T06:00:00.000Z');

    assert({
      given: 'a claim first seen earlier the same day',
      should: 'fall on or after the cutoff, so it is not promotable yet',
      actual: firstSeenThisMorning < promotionCutoff(now),
      expected: false,
    });
  });

  it('includes a claim first seen yesterday', async () => {
    const { promotionCutoff } = await import('../candidate-service');

    const now = new Date('2026-03-10T00:30:00.000Z');
    const firstSeenYesterday = new Date('2026-03-09T23:00:00.000Z');

    assert({
      given: 'a claim first seen the previous UTC day',
      should: 'fall before the cutoff, so it is eligible',
      actual: firstSeenYesterday < promotionCutoff(now),
      expected: true,
    });
  });
});

describe('PROMOTION_THRESHOLD', () => {
  it('holds bio to a stricter bar than the behavioural fields', async () => {
    const { PROMOTION_THRESHOLD } = await import('../candidate-service');

    assert({
      given: 'the per-field promotion thresholds',
      should: 'require more corroboration for identity claims than for preferences',
      actual: PROMOTION_THRESHOLD.bio > PROMOTION_THRESHOLD.writingStyle,
      expected: true,
    });
  });
});
