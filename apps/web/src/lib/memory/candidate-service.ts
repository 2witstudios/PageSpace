/**
 * Memory Candidate Service
 *
 * Manages the staging table for insights awaiting corroboration.
 * Insights must be observed on multiple distinct UTC days before promotion
 * to the actual personalization pages.
 */

import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from '@pagespace/db/operators';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { personalizationCandidates } from '@pagespace/db/schema/personalization';
import { loggers } from '@pagespace/lib/logging/logger-config';
// Single definition, owned by the producer. A local copy here had already
// drifted — it lacked `evidenceAt`, so the staging table could not have seen
// the evidence date even once discovery started supplying it.
import type { DiscoveredClaim, MemoryField } from './discovery-service';

export type { DiscoveredClaim, MemoryField };

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

/** The field names, as runtime values, for building per-field SQL predicates. */
const MEMORY_FIELD_NAMES = Object.keys(PROMOTION_THRESHOLD) as MemoryField[];

/** Candidates not re-observed within this many days are forgotten. */
export const STALE_CANDIDATE_DAYS = 30;

/**
 * How long a settled candidate keeps its verbatim `evidence` quote.
 *
 * Longer than the pending window because a subject access request should still
 * be able to show WHY a claim in the profile was accepted for a reasonable
 * period after it was. After that the quote has served its purpose and is
 * redacted; the claim itself is retained for deduplication.
 */
export const SETTLED_EVIDENCE_RETENTION_DAYS = 90;

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
 * Compares the days the SUPPORTING EVIDENCE was written on — never the days the
 * cron happened to run.
 *
 * That distinction is the whole guarantee. Discovery re-reads a rolling 7-day
 * window every night, so one unchanged message is rediscovered on consecutive
 * runs. Counting cron days would promote a genuine one-off after two or three
 * nights while the user said nothing new, which is exactly the failure the
 * staging table exists to prevent. Counting evidence days means a claim only
 * advances when the person actually said something on another day.
 */
export function shouldIncrementOccurrences(
  lastEvidenceAt: Date,
  newEvidenceAt: Date
): boolean {
  return utcDayKey(lastEvidenceAt) !== utcDayKey(newEvidenceAt);
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
  claims: DiscoveredClaim[]
): Promise<number> {
  if (claims.length === 0) return 0;

  let upserted = 0;

  for (const claim of claims) {
    const claimKey = normalizeClaimKey(claim.claim);
    if (!claimKey) continue;

    // Look up the row WITHOUT filtering on promoted/rejected. The unique index
    // is on (userId, field, claimKey) unconditionally, so an active-only lookup
    // would miss a settled row and then collide on insert — aborting the whole
    // user's run every night once any recurring wording had been settled once.
    const [existing] = await db
      .select({
        id: personalizationCandidates.id,
        occurrences: personalizationCandidates.occurrences,
        lastSeenAt: personalizationCandidates.lastSeenAt,
        promotedAt: personalizationCandidates.promotedAt,
        rejectedAt: personalizationCandidates.rejectedAt,
      })
      .from(personalizationCandidates)
      .where(
        and(
          eq(personalizationCandidates.userId, userId),
          eq(personalizationCandidates.field, claim.field),
          eq(personalizationCandidates.claimKey, claimKey),
        )
      )
      .limit(1);

    if (!existing) {
      // `onConflictDoNothing` rather than a bare insert: two runs for the same
      // user (a retry overlapping the scheduled pass) can both find no row and
      // race to insert. Losing that race must be a no-op, not an exception that
      // aborts every remaining claim — the winner's row is identical anyway,
      // and the loser's evidence is folded in on the next pass.
      const inserted = await db
        .insert(personalizationCandidates)
        .values({
          id: createId(),
          userId,
          field: claim.field,
          claim: claim.claim,
          claimKey,
          evidence: claim.evidence,
          occurrences: 1,
          firstSeenAt: claim.evidenceAt,
          lastSeenAt: claim.evidenceAt,
        })
        .onConflictDoNothing()
        .returning({ id: personalizationCandidates.id });

      if (inserted.length > 0) upserted++;
      continue;
    }

    // Already settled. A promoted claim is in the profile already, and a
    // rejected one was declined against that profile — re-staging either would
    // just re-spend tokens re-deciding a question already answered. Skipping
    // also keeps the row's terminal timestamps meaningful as a record of when
    // that decision was made.
    if (existing.promotedAt || existing.rejectedAt) continue;

    const shouldIncrement = shouldIncrementOccurrences(existing.lastSeenAt, claim.evidenceAt);

    // Guarded by the lastSeenAt we read. If a concurrent run advanced the row
    // first, this matches nothing and the increment is skipped rather than
    // double-counting the same evidence day — the count stays a count of
    // distinct days, not of how many times the cron overlapped itself.
    const updated = await db
      .update(personalizationCandidates)
      .set({
        occurrences: shouldIncrement ? existing.occurrences + 1 : existing.occurrences,
        // Never move lastSeenAt backwards: re-reading an older message must not
        // make a claim look staler than evidence already counted for it.
        lastSeenAt: claim.evidenceAt > existing.lastSeenAt ? claim.evidenceAt : existing.lastSeenAt,
        evidence: claim.evidence, // keep most recent evidence
      })
      .where(
        and(
          eq(personalizationCandidates.id, existing.id),
          eq(personalizationCandidates.lastSeenAt, existing.lastSeenAt),
        )
      )
      .returning({ id: personalizationCandidates.id });

    if (updated.length > 0) upserted++;
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

  // One (field = X AND occurrences >= N) branch per field, OR'd together.
  //
  // Built from PROMOTION_THRESHOLD so the constant stays the single source of
  // truth. Deliberately NOT a parameterised `CASE field WHEN 'bio' THEN $n`:
  // the bound parameters carry no type, so Postgres cannot resolve `integer >=
  // unknown` and the whole query fails with 42883 — every cron run, for every
  // user. Nothing here is user input (the thresholds are compile-time
  // constants and the field names are our own enum), so there is no value in
  // parameterising them.
  const meetsThreshold = or(
    ...MEMORY_FIELD_NAMES.map((field) =>
      and(
        eq(personalizationCandidates.field, field),
        gte(personalizationCandidates.occurrences, PROMOTION_THRESHOLD[field])
      )
    )
  );

  return db
    .select()
    .from(personalizationCandidates)
    .where(
      and(
        eq(personalizationCandidates.userId, userId),
        isNull(personalizationCandidates.promotedAt),
        isNull(personalizationCandidates.rejectedAt),
        lt(personalizationCandidates.firstSeenAt, cutoff),
        meetsThreshold
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

/** Placeholder left in `evidence` once a settled row passes its retention window. */
export const REDACTED_EVIDENCE = '[evidence redacted after retention period]';

/**
 * Drop the verbatim quote from candidates that settled long enough ago.
 *
 * `evidence` is a direct quote of something the user wrote. It earns its keep
 * while a claim is pending — it is what justifies promoting or declining the
 * claim, and what a subject sees when asking why the AI believes something —
 * but once the row is promoted or rejected the decision is made and the quote
 * is just retained personal data with no remaining purpose. Art 5(1)(e) says
 * that has to stop.
 *
 * The ROW survives, with `claim` and `claimKey` intact, because those are what
 * `upsertCandidates` needs to recognise a recurring claim and avoid colliding
 * on the unique index. Only the quote goes.
 */
export async function redactSettledEvidence(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - SETTLED_EVIDENCE_RETENTION_DAYS);

  const redacted = await db
    .update(personalizationCandidates)
    .set({ evidence: REDACTED_EVIDENCE })
    .where(
      and(
        eq(personalizationCandidates.userId, userId),
        ne(personalizationCandidates.evidence, REDACTED_EVIDENCE),
        or(
          and(
            isNotNull(personalizationCandidates.promotedAt),
            lt(personalizationCandidates.promotedAt, cutoff)
          ),
          and(
            isNotNull(personalizationCandidates.rejectedAt),
            lt(personalizationCandidates.rejectedAt, cutoff)
          )
        )
      )
    )
    .returning({ id: personalizationCandidates.id });

  if (redacted.length > 0) {
    loggers.api.debug('Memory settled candidate evidence redacted', {
      userId,
      count: redacted.length,
    });
  }

  return redacted.length;
}
