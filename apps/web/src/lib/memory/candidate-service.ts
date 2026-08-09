/**
 * Memory Candidate Service
 *
 * Manages the staging table for insights awaiting corroboration.
 * Insights must be observed on multiple distinct UTC days before promotion
 * to the actual personalization pages.
 */

import { and, eq, inArray, isNull, lt, sql } from '@pagespace/db/operators';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { personalizationCandidates } from '@pagespace/db/schema/personalization';
import { loggers } from '@pagespace/lib/logging/logger-config';

export type MemoryField = 'bio' | 'writingStyle' | 'rules';

export interface DiscoveredClaim {
  field: MemoryField;
  claim: string;
  evidence: string;
  occurrencesInWindow: number;
}

/**
 * Corroboration thresholds, in distinct observation days.
 *
 * `bio` is stricter: a wrong identity claim reads as the AI having decided who
 * you are, which is more costly than a wrong formatting preference.
 */
export const PROMOTION_THRESHOLD: Record<MemoryField, number> = {
  bio: 3,
  writingStyle: 2,
  rules: 2,
};

/** Candidates not re-observed within this many days are forgotten. */
export const STALE_CANDIDATE_DAYS = 30;

/**
 * Normalize a claim to its key for deduplication.
 *
 * Lowercased, punctuation-stripped, whitespace-collapsed, so "Be concise." and
 * "be concise" are the same claim rather than two candidates that each corroborate
 * only themselves.
 */
export function normalizeClaimKey(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // remove punctuation
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}

/** The UTC calendar day a timestamp falls on, as `YYYY-MM-DD`. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Whether re-observing a claim should raise its corroboration count.
 *
 * Occurrences count DISTINCT DAYS, not sightings. Without this, a single long
 * session saying the same thing three times would promote a claim the user has
 * expressed exactly once — which is the failure mode the whole staging table
 * exists to prevent.
 */
export function shouldIncrementOccurrences(lastSeenAt: Date, now: Date): boolean {
  return utcDayKey(lastSeenAt) !== utcDayKey(now);
}

/**
 * Upsert discovered claims into the candidates table.
 *
 * For each claim:
 * - If it exists, increment `occurrences` and update `lastSeenAt`
 * - `occurrences` ONLY increments when the new `lastSeenAt` falls on a different
 *   UTC day than the old one — this prevents one chatty afternoon from
 *   self-corroborating
 * - If it doesn't exist, insert with `occurrences = 1`
 *
 * Returns the number of claims upserted.
 */
export async function upsertCandidates(
  userId: string,
  claims: DiscoveredClaim[],
  now: Date = new Date()
): Promise<number> {
  if (claims.length === 0) return 0;

  let upserted = 0;

  for (const claim of claims) {
    const claimKey = normalizeClaimKey(claim.claim);
    if (!claimKey) continue;

    // Check if this claim already exists
    const [existing] = await db
      .select({
        id: personalizationCandidates.id,
        occurrences: personalizationCandidates.occurrences,
        lastSeenAt: personalizationCandidates.lastSeenAt,
      })
      .from(personalizationCandidates)
      .where(
        and(
          eq(personalizationCandidates.userId, userId),
          eq(personalizationCandidates.field, claim.field),
          eq(personalizationCandidates.claimKey, claimKey),
          isNull(personalizationCandidates.promotedAt),
          isNull(personalizationCandidates.rejectedAt),
        )
      )
      .limit(1);

    if (existing) {
      const occurrences = shouldIncrementOccurrences(existing.lastSeenAt, now)
        ? existing.occurrences + 1
        : existing.occurrences;

      await db
        .update(personalizationCandidates)
        .set({
          occurrences,
          lastSeenAt: now,
          evidence: claim.evidence, // keep most recent evidence
        })
        .where(eq(personalizationCandidates.id, existing.id));

      upserted++;
    } else {
      // Insert new candidate
      await db.insert(personalizationCandidates).values({
        id: createId(),
        userId,
        field: claim.field,
        claim: claim.claim,
        claimKey,
        evidence: claim.evidence,
        occurrences: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      });

      upserted++;
    }
  }

  loggers.api.debug('Memory candidates upserted', {
    userId,
    count: upserted,
  });

  return upserted;
}

/**
 * The cutoff a candidate's `firstSeenAt` must precede to be promotable:
 * midnight UTC at the start of today.
 *
 * This is what makes "corroborated across days" real rather than nominal. A
 * claim first seen at any point today is younger than a full calendar day, so
 * it cannot be promoted in the same run that discovered it — no matter how many
 * times it appeared.
 */
export function promotionCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff;
}

/**
 * Find candidates ready for promotion.
 *
 * Criteria:
 * - `occurrences` at or above the field's threshold (see `PROMOTION_THRESHOLD`)
 * - `firstSeenAt` before the start of today, UTC
 * - Not already promoted or rejected
 */
export async function findPromotableCandidates(
  userId: string,
  now: Date = new Date()
): Promise<typeof personalizationCandidates.$inferSelect[]> {
  const cutoff = promotionCutoff(now);

  return db
    .select()
    .from(personalizationCandidates)
    .where(
      and(
        eq(personalizationCandidates.userId, userId),
        isNull(personalizationCandidates.promotedAt),
        isNull(personalizationCandidates.rejectedAt),
        lt(personalizationCandidates.firstSeenAt, cutoff),
        // Per-field threshold, derived from PROMOTION_THRESHOLD so the constant
        // stays the single source of truth rather than drifting from the SQL.
        sql`${personalizationCandidates.occurrences} >= CASE ${personalizationCandidates.field}
          WHEN 'bio' THEN ${PROMOTION_THRESHOLD.bio}
          WHEN 'writingStyle' THEN ${PROMOTION_THRESHOLD.writingStyle}
          ELSE ${PROMOTION_THRESHOLD.rules} END`
      )
    );
}

/**
 * Mark candidates as promoted.
 *
 * Called after successful integration into the personalization pages.
 */
export async function markCandidatesPromoted(
  candidateIds: string[]
): Promise<void> {
  if (candidateIds.length === 0) return;

  await db
    .update(personalizationCandidates)
    .set({ promotedAt: new Date() })
    .where(inArray(personalizationCandidates.id, candidateIds));
}

/**
 * Mark candidates as rejected.
 *
 * Called when the evaluator decides a claim should not be integrated.
 */
export async function markCandidatesRejected(
  candidateIds: string[]
): Promise<void> {
  if (candidateIds.length === 0) return;

  await db
    .update(personalizationCandidates)
    .set({ rejectedAt: new Date() })
    .where(inArray(personalizationCandidates.id, candidateIds));
}

/**
 * Prune stale candidates.
 *
 * Deletes candidates that haven't been re-observed in 30 days.
 * This is the "forgetting" half of the system — claims that stop being
 * true or stop being relevant are automatically dropped.
 */
export async function pruneStaleCandidates(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - STALE_CANDIDATE_DAYS);

  // Single statement: `returning()` reports exactly the rows this delete
  // removed. Counting first and deleting second would both duplicate the
  // predicate and let a concurrent write land between the two.
  const deleted = await db
    .delete(personalizationCandidates)
    .where(
      and(
        eq(personalizationCandidates.userId, userId),
        lt(personalizationCandidates.lastSeenAt, cutoff),
        isNull(personalizationCandidates.promotedAt),
        isNull(personalizationCandidates.rejectedAt),
      )
    )
    .returning({ id: personalizationCandidates.id });

  if (deleted.length > 0) {
    loggers.api.debug('Memory stale candidates pruned', {
      userId,
      count: deleted.length,
    });
  }

  return deleted.length;
}
