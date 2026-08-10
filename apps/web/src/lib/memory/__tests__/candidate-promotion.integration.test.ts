/**
 * Candidate promotion, against a REAL Postgres.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The unit tests beside it mock the database, so they never execute SQL. That
 * hid a defect the first real query surfaced immediately: the per-field
 * threshold was written as
 *
 *     occurrences >= CASE field WHEN 'bio' THEN $3 ... END
 *
 * and Postgres cannot resolve `integer >= unknown` for an untyped bound
 * parameter. It fails with 42883 — on every cron run, for every user, so no
 * memory would ever have been promoted. Every mocked test passed throughout.
 *
 * So the corroboration rule is pinned HERE, where the query actually runs:
 * distinct-evidence-day counting, the same-day cutoff, and the stricter bar
 * for `bio` (3 days) than for the behavioural fields (2).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { personalizationCandidates } from '@pagespace/db/schema/personalization';
import { factories } from '@pagespace/db/test/factories';
import {
  upsertCandidates,
  findPromotableCandidates,
  markCandidatesPromoted,
  redactSettledEvidence,
  REDACTED_EVIDENCE,
  type DiscoveredClaim,
  type MemoryField,
} from '@/lib/memory/candidate-service';

let dbAvailable = false;

const DAY1 = new Date('2026-03-01T10:00:00.000Z');
const DAY1_LATER = new Date('2026-03-01T22:00:00.000Z');
const DAY2 = new Date('2026-03-02T10:00:00.000Z');
const DAY3 = new Date('2026-03-03T10:00:00.000Z');
const LATER = new Date('2026-03-05T00:00:00.000Z');

function claim(field: MemoryField, evidenceAt: Date): DiscoveredClaim {
  return {
    field,
    claim: `${field} claim`,
    evidence: 'a verbatim quote',
    occurrencesInWindow: 1,
    evidenceAt,
  };
}

async function freshUser(): Promise<string> {
  const user = await factories.createUser();
  return user.id;
}

describe('candidate promotion (Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(personalizationCandidates).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('counts distinct evidence days, not repeated reads of the same message', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const userId = await freshUser();

    await upsertCandidates(userId, [claim('rules', DAY1)]);
    // The nightly window re-reads the SAME message; that is not corroboration.
    await upsertCandidates(userId, [claim('rules', DAY1_LATER)]);

    const [afterSameDay] = await db
      .select()
      .from(personalizationCandidates)
      .where(eq(personalizationCandidates.userId, userId));
    expect(afterSameDay.occurrences).toBe(1);

    // The user says it again on another day. That is.
    await upsertCandidates(userId, [claim('rules', DAY2)]);

    const [afterNewDay] = await db
      .select()
      .from(personalizationCandidates)
      .where(eq(personalizationCandidates.userId, userId));
    expect(afterNewDay.occurrences).toBe(2);
  });

  it('will not promote a claim on the day it was first seen', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const userId = await freshUser();

    await upsertCandidates(userId, [claim('rules', DAY1)]);
    await upsertCandidates(userId, [claim('rules', DAY2)]);

    const sameDay = await findPromotableCandidates(userId, new Date('2026-03-01T12:00:00.000Z'));
    expect(sameDay).toHaveLength(0);

    const later = await findPromotableCandidates(userId, LATER);
    expect(later).toHaveLength(1);
  });

  it('holds bio to three days where the behavioural fields need two', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const userId = await freshUser();

    await upsertCandidates(userId, [claim('bio', DAY1), claim('rules', DAY1)]);
    await upsertCandidates(userId, [claim('bio', DAY2), claim('rules', DAY2)]);

    const atTwoDays = await findPromotableCandidates(userId, LATER);
    expect(atTwoDays.map((c) => c.field).sort()).toEqual(['rules']);

    await upsertCandidates(userId, [claim('bio', DAY3)]);

    const atThreeDays = await findPromotableCandidates(userId, LATER);
    expect(atThreeDays.map((c) => c.field).sort()).toEqual(['bio', 'rules']);
  });

  it('re-observing a settled claim does not collide with the unique index', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const userId = await freshUser();

    await upsertCandidates(userId, [claim('rules', DAY1)]);
    const [row] = await db
      .select()
      .from(personalizationCandidates)
      .where(eq(personalizationCandidates.userId, userId));
    await markCandidatesPromoted([row.id]);

    // The unique index covers settled rows too, so an active-only lookup would
    // miss this one and the insert would throw — aborting every remaining claim
    // for this user, every night.
    await expect(upsertCandidates(userId, [claim('rules', DAY3)])).resolves.toBeTypeOf('number');
  });

  it('redacts the verbatim quote once a settled row passes its retention window', async () => {
    if (!dbAvailable) throw new Error('DATABASE_URL must point at a migrated Postgres');
    const userId = await freshUser();

    await upsertCandidates(userId, [claim('rules', DAY1)]);
    const [row] = await db
      .select()
      .from(personalizationCandidates)
      .where(eq(personalizationCandidates.userId, userId));

    await db
      .update(personalizationCandidates)
      .set({ promotedAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(personalizationCandidates.id, row.id));

    await redactSettledEvidence(userId);

    const [after] = await db
      .select()
      .from(personalizationCandidates)
      .where(eq(personalizationCandidates.id, row.id));

    expect(after.evidence).toBe(REDACTED_EVIDENCE);
    // The claim survives: deduplication needs it to recognise a recurring claim.
    expect(after.claim).toBe('rules claim');
  });
});
