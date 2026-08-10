import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

/**
 * Candidate Service Tests
 *
 * The candidate table is what makes "corroborated across days" enforceable.
 * These tests pin the two rules that make it work:
 *   - occurrences count DISTINCT DAYS, not sightings
 *   - a claim first seen today cannot be promoted today
 */

/**
 * A minimal fake of the drizzle chain `upsertCandidates` drives, recording the
 * values it is asked to write so the CALL SITE can be asserted — not just the
 * pure helpers it delegates to.
 */
const dbCalls: { updates: Record<string, unknown>[]; inserts: Record<string, unknown>[] } = {
  updates: [],
  inserts: [],
};
let existingRow: Record<string, unknown> | null = null;

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(existingRow ? [existingRow] : []) }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        dbCalls.inserts.push(v);
        // Mirrors the real chain: insert ... on conflict do nothing returning id.
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: 'new' }]) }),
        };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        dbCalls.updates.push(v);
        return { where: () => ({ returning: () => Promise.resolve([{ id: 'c1' }]) }) };
      },
    }),
  },
}));
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
  it('does not increment for evidence written the same UTC day', async () => {
    const { shouldIncrementOccurrences } = await import('../candidate-service');

    const morning = new Date('2026-03-10T08:00:00.000Z');
    const evening = new Date('2026-03-10T23:59:59.000Z');

    assert({
      given: 'supporting evidence from earlier the same UTC day',
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
      given: 'evidence either side of midnight UTC',
      should: 'count as corroboration on a distinct day',
      actual: shouldIncrementOccurrences(beforeMidnight, afterMidnight),
      expected: true,
    });
  });

  it('does not corroborate an unchanged message re-read on a later cron day', async () => {
    // The failure this whole staging table exists to prevent, and the one a
    // cron-day comparison silently reintroduces: discovery re-reads a rolling
    // 7-day window every night, so ONE message is rediscovered on consecutive
    // runs. Only the evidence date may advance the count.
    const { shouldIncrementOccurrences } = await import('../candidate-service');

    const theOnlyMessage = new Date('2026-03-10T12:00:00.000Z');

    assert({
      given: 'the same single message re-read by a later nightly run',
      should: 'not corroborate itself, however many nights it is re-read',
      actual: shouldIncrementOccurrences(theOnlyMessage, theOnlyMessage),
      expected: false,
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

describe('upsertCandidates — what the corroboration count is measured against', () => {
  const claim = (evidenceAt: Date) => ({
    field: 'rules' as const,
    claim: 'Never use emojis',
    evidence: 'no emojis please',
    occurrencesInWindow: 1,
    evidenceMessageIndex: 0,
    evidenceAt,
  });

  beforeEach(() => {
    dbCalls.updates = [];
    dbCalls.inserts = [];
    existingRow = null;
  });

  it('does not advance the count when the same message is re-read on a later day', async () => {
    // Binds the CALL SITE, not just the helper: discovery re-reads a rolling
    // 7-day window nightly, so passing the cron's own clock here would promote
    // a one-off after two or three runs. Only the evidence date may count.
    const theOnlyMessage = new Date('2026-03-10T12:00:00.000Z');
    existingRow = {
      id: 'c1',
      occurrences: 1,
      lastSeenAt: theOnlyMessage,
      promotedAt: null,
      rejectedAt: null,
    };

    const { upsertCandidates } = await import('../candidate-service');
    await upsertCandidates('user-1', [claim(theOnlyMessage)]);

    assert({
      given: 'a claim re-derived from the same unchanged message on a later cron run',
      should: 'leave occurrences untouched',
      actual: dbCalls.updates[0]?.occurrences,
      expected: 1,
    });
  });

  it('advances the count when newer evidence arrives on another day', async () => {
    existingRow = {
      id: 'c1',
      occurrences: 1,
      lastSeenAt: new Date('2026-03-10T12:00:00.000Z'),
      promotedAt: null,
      rejectedAt: null,
    };

    const { upsertCandidates } = await import('../candidate-service');
    await upsertCandidates('user-1', [claim(new Date('2026-03-11T09:00:00.000Z'))]);

    assert({
      given: 'the user saying the same thing again on a later day',
      should: 'count it as corroboration',
      actual: dbCalls.updates[0]?.occurrences,
      expected: 2,
    });
  });

  it('never moves lastSeenAt backwards when older evidence is re-read', async () => {
    const newest = new Date('2026-03-12T09:00:00.000Z');
    existingRow = {
      id: 'c1',
      occurrences: 2,
      lastSeenAt: newest,
      promotedAt: null,
      rejectedAt: null,
    };

    const { upsertCandidates } = await import('../candidate-service');
    await upsertCandidates('user-1', [claim(new Date('2026-03-10T09:00:00.000Z'))]);

    assert({
      given: 'an older supporting message re-read after a newer one',
      should: 'keep the newest evidence date, so the claim does not look staler than it is',
      actual: dbCalls.updates[0]?.lastSeenAt,
      expected: newest,
    });
  });

  it('leaves an already-settled claim alone instead of colliding on insert', async () => {
    // The unique index is on (userId, field, claimKey) unconditionally, so an
    // active-only lookup would miss this row and the insert would throw,
    // aborting every remaining claim for this user.
    existingRow = {
      id: 'c1',
      occurrences: 3,
      lastSeenAt: new Date('2026-03-10T12:00:00.000Z'),
      promotedAt: new Date('2026-03-11T00:00:00.000Z'),
      rejectedAt: null,
    };

    const { upsertCandidates } = await import('../candidate-service');
    await upsertCandidates('user-1', [claim(new Date('2026-03-12T09:00:00.000Z'))]);

    assert({
      given: 'a recurring claim that was already promoted',
      should: 'neither re-insert nor re-update it',
      actual: { inserts: dbCalls.inserts.length, updates: dbCalls.updates.length },
      expected: { inserts: 0, updates: 0 },
    });
  });

  it('stamps a new candidate with the evidence date, not the run time', async () => {
    existingRow = null;
    const evidenceAt = new Date('2026-03-10T12:00:00.000Z');

    const { upsertCandidates } = await import('../candidate-service');
    await upsertCandidates('user-1', [claim(evidenceAt)]);

    assert({
      given: 'a newly staged claim',
      should: 'date it from its evidence so the promotion cutoff measures real elapsed days',
      actual: {
        firstSeenAt: dbCalls.inserts[0]?.firstSeenAt,
        lastSeenAt: dbCalls.inserts[0]?.lastSeenAt,
      },
      expected: { firstSeenAt: evidenceAt, lastSeenAt: evidenceAt },
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
