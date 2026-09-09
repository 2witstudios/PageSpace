/**
 * Memory Cron Route
 *
 * Daily background process that discovers patterns from user conversations
 * and updates their personalization profile (stored as pages in their Home drive).
 *
 * Pipeline:
 * 1. Get paying users with recent activity
 * 2. For each user:
 *    a. Run discovery passes (blind — never sees the current profile)
 *    b. Stage the claims as candidates. Corroboration counts the days the
 *       EVIDENCE was written on, not the days this cron ran: the discovery
 *       window is reread in full every night, so cron-day counting would
 *       promote a one-off after two or three runs.
 *    c. Find candidates past the per-field day threshold AND first seen before
 *       today, so nothing discovered today can land today
 *    d. Evaluate them against the current pages; the evaluator reports which
 *       candidates it used
 *    e. Write the pages, subject to the rewrite guards
 *    f. Settle each candidate on what actually landed — promoted only if it was
 *       used AND its page write succeeded; declined ones rejected; anything
 *       blocked stays pending for the next run. An evaluator that never
 *       reached a decision settles nothing.
 *    g. Compact any page over budget
 *    h. Retention: drop candidates not re-observed in 30 days, and redact the
 *       verbatim evidence of ones settled 90+ days ago. Runs on EVERY exit
 *       path, including the failure ones.
 *
 * Paying users only — gated on MEMORY_PAYING_TIERS, the same constant the
 * settings UI uses, so the two cannot disagree about who gets Memory.
 *
 * Security: HMAC-signed cron requests via cron-curl (X-Cron-Timestamp/Nonce/Signature)
 * Trigger via: cron-curl POST http://web:3000/api/memory/cron
 */

import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { and, eq, gte, inArray, isNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { MEMORY_PAYING_TIERS } from '@pagespace/lib/billing/automation-preferences';
import { runDiscoveryPasses } from '@/lib/memory/discovery-service';
import {
  getCurrentPersonalizationPages,
  evaluateAndIntegrate,
  applyIntegrationDecisions,
} from '@/lib/memory/integration-service';
import { checkAndCompactIfNeeded } from '@/lib/memory/compaction-service';
import {
  upsertCandidates,
  findPromotableCandidates,
  markCandidatesPromoted,
  markCandidatesRejected,
  pruneStaleCandidates,
  redactSettledEvidence,
  type MemoryField,
} from '@/lib/memory/candidate-service';

/**
 * Reuses the constant the settings UI gates on rather than restating it.
 *
 * A local copy would let the cron and `isMemoryAvailable` drift: a tier added
 * to one and not the other means users who are told Memory is available never
 * have anything learned, or the reverse — learning for users the product says
 * cannot have it. Neither failure is visible from either side alone.
 */
const PAYING_TIERS = [...MEMORY_PAYING_TIERS];

const DELAY_BETWEEN_USERS_MS = 1000;

export async function POST(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const activePayingUsers = await db
      .select({
        userId: sessions.userId,
        subscriptionTier: users.subscriptionTier,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.type, 'user'),
          isNull(sessions.revokedAt),
          gte(sessions.lastUsedAt, sevenDaysAgo),
          inArray(users.subscriptionTier, PAYING_TIERS)
        )
      )
      .groupBy(sessions.userId, users.subscriptionTier);

    const uniqueUserIds = [...new Set(activePayingUsers.map((u) => u.userId))];

    if (uniqueUserIds.length === 0) {
      loggers.api.info('Memory cron: No active paying users found');
      return NextResponse.json({
        message: 'No active paying users',
        processed: 0,
      });
    }

    const usersWithPersonalization = await db
      .select({
        userId: userPersonalization.userId,
        enabled: userPersonalization.enabled,
      })
      .from(userPersonalization)
      .where(inArray(userPersonalization.userId, uniqueUserIds));

    const personalizationByUserId = new Map(
      usersWithPersonalization.map((u) => [u.userId, u.enabled] as const)
    );
    const usersToProcess = uniqueUserIds.filter(
      (id) => personalizationByUserId.get(id) ?? true
    );

    if (usersToProcess.length === 0) {
      loggers.api.info('Memory cron: No users with personalization enabled');
      return NextResponse.json({
        message: 'No users with personalization enabled',
        processed: 0,
      });
    }

    loggers.api.info(`Memory cron: Processing ${usersToProcess.length} users`);

    const results = {
      processed: 0,
      discovered: 0,
      promoted: 0,
      updated: 0,
      compacted: 0,
      pruned: 0,
      errors: [] as string[],
    };

    for (const userId of usersToProcess) {
      try {
        const userResult = await processUserMemory(userId);

        results.processed++;
        results.discovered += userResult.discovered;
        results.promoted += userResult.promoted;
        if (userResult.updated) results.updated++;
        if (userResult.compacted) results.compacted++;
        results.pruned += userResult.pruned;

        if (usersToProcess.indexOf(userId) < usersToProcess.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_USERS_MS));
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        loggers.api.error(`Memory cron: Error processing user ${userId}`, {
          error: errorMsg,
        });
        results.errors.push(`${userId}: ${errorMsg}`);
      }
    }

    loggers.api.info('Memory cron: Complete', {
      processed: results.processed,
      discovered: results.discovered,
      promoted: results.promoted,
      updated: results.updated,
      compacted: results.compacted,
      pruned: results.pruned,
      errors: results.errors.length,
    });

    return NextResponse.json({
      message: 'Memory processing complete',
      ...results,
      errors: results.errors.length > 0 ? results.errors : undefined,
    });
  } catch (error) {
    loggers.api.error('Memory cron: Fatal error', { error });
    return NextResponse.json({ error: 'Cron job failed' }, { status: 500 });
  }
}

/**
 * Retention housekeeping, run on EVERY exit path.
 *
 * Forgetting must not be conditional on the happy path: a user whose evaluator
 * is failing, or who has nothing promotable, still has stale candidates to drop
 * and settled quotes past their retention window. Tying either to a successful
 * run would leave the longest-neglected accounts the least cleaned up.
 *
 * Returns the pruned count; redaction is reported through logs, since it is a
 * compliance action rather than a signal about this run's work.
 */
async function runRetention(userId: string): Promise<number> {
  const [pruned] = await Promise.all([
    pruneStaleCandidates(userId),
    redactSettledEvidence(userId),
  ]);
  return pruned;
}

async function processUserMemory(
  userId: string
): Promise<{
  discovered: number;
  promoted: number;
  updated: boolean;
  compacted: boolean;
  pruned: number;
}> {
  // Step 1: Run discovery passes
  const discoveryResult = await runDiscoveryPasses(userId);
  const discovered = discoveryResult.claims.length;

  // Step 2: Stage what was discovered. An empty discovery is NOT a reason to
  // stop: candidates left pending by an earlier guard rejection or provider
  // outage are already corroborated and still deserve evaluation, and a quiet
  // week would otherwise strand them indefinitely.
  if (discovered > 0) {
    await upsertCandidates(userId, discoveryResult.claims);
  }

  // Step 3: Find candidates that have cleared the corroboration bar
  const promotable = await findPromotableCandidates(userId);

  if (promotable.length === 0) {
    loggers.api.debug('Memory cron: No candidates ready for promotion', { userId });
    const pruned = await runRetention(userId);
    return {
      discovered,
      promoted: 0,
      updated: false,
      compacted: false,
      pruned,
    };
  }

  // Step 4: Get current page content
  const currentPages = await getCurrentPersonalizationPages(userId);

  // Step 5: Evaluate
  const evaluation = await evaluateAndIntegrate(userId, promotable, currentPages);

  // The evaluator never reached a decision (provider down, generation error,
  // unparseable response). Leave every candidate pending — settling them here
  // would permanently retire a user's whole ready set over a transient outage.
  if (!evaluation.ok) {
    loggers.api.warn('Memory cron: evaluation failed, candidates left pending', {
      userId,
      reason: evaluation.reason,
      pending: promotable.length,
    });
    const pruned = await runRetention(userId);
    return {
      discovered,
      promoted: 0,
      updated: false,
      compacted: false,
      pruned,
    };
  }

  // Step 6: Apply updates with guards
  const applyResult = await applyIntegrationDecisions(
    userId,
    evaluation.updates,
    currentPages
  );

  // Step 6b: Settle each candidate INDIVIDUALLY.
  //
  // Field-level settling was wrong: several candidates can share a field, and
  // the evaluator may incorporate one while declining another. Marking the
  // whole field promoted retired claims that never reached the page. So a
  // candidate is promoted only when the evaluator cited it AND the page write
  // for its field actually landed.
  //
  // Declined claims are marked REJECTED rather than left pending: the evaluator
  // saw them against the current profile and said no, and re-staging them would
  // re-spend tokens re-deciding the same question every night. Anything blocked
  // by a guard or a failed write stays pending so the next run can retry.
  const written = new Set(applyResult.fields);
  const blocked = new Set(applyResult.rejected.map((r) => r.field));
  const used = new Set(evaluation.usedCandidateIds);

  const promotedIds: string[] = [];
  const rejectedIds: string[] = [];

  for (const candidate of promotable) {
    const field = candidate.field as MemoryField;

    if (used.has(candidate.id)) {
      // Cited by the evaluator — promoted only if the write landed.
      if (written.has(field)) promotedIds.push(candidate.id);
      // else: guard-rejected or write failed → stays pending.
      continue;
    }

    // Not cited. Declined by the evaluator, unless its field never got a
    // verdict at all (blocked write), in which case leave it pending.
    if (!blocked.has(field)) rejectedIds.push(candidate.id);
  }

  await Promise.all([
    markCandidatesPromoted(promotedIds),
    markCandidatesRejected(rejectedIds),
  ]);

  // Step 7: Compact if needed
  let compacted = false;
  if (applyResult.updated) {
    const compactionResult = await checkAndCompactIfNeeded(userId);
    compacted = compactionResult.compacted;
  }

  // Step 8: Prune stale candidates
  const pruned = await runRetention(userId);

  loggers.api.info('Memory cron: User processed', {
    userId,
    discovered,
    // Counts settled outcomes, not the size of the ready set. Reporting
    // `promotable.length` as "promoted" counted evaluator-declined and
    // guard-pending candidates as though they had reached the profile.
    eligible: promotable.length,
    promoted: promotedIds.length,
    declined: rejectedIds.length,
    stillPending: promotable.length - promotedIds.length - rejectedIds.length,
    updated: applyResult.updated,
    updatedFields: applyResult.fields,
    rejected: applyResult.rejected,
    compacted,
    pruned,
  });

  return {
    discovered,
    promoted: promotedIds.length,
    updated: applyResult.updated,
    compacted,
    pruned,
  };
}

export async function GET(request: Request) {
  return POST(request);
}
