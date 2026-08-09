/**
 * Memory Cron Route
 *
 * Daily background process that discovers patterns from user conversations
 * and updates their personalization profile (stored as pages in their Home drive).
 *
 * Pipeline:
 * 1. Get paying users with recent activity
 * 2. For each user:
 *    a. Run discovery passes (blind - doesn't see current profile)
 *    b. Upsert candidates (with day-aware occurrence increment)
 *    c. Promote candidates that meet corroboration criteria
 *    d. Evaluate and integrate promoted candidates into pages
 *    e. Compact if fields exceed budget
 *    f. Prune stale candidates (30-day forgetting)
 *
 * Paying users only: 'pro', 'founder', 'business' subscription tiers
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
  type MemoryField,
} from '@/lib/memory/candidate-service';

const PAYING_TIERS = ['pro', 'founder', 'business'];

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

  if (discovered === 0) {
    loggers.api.debug('Memory cron: No claims discovered for user', { userId });
    // Still run prune even if nothing discovered
    const pruned = await pruneStaleCandidates(userId);
    return {
      discovered: 0,
      promoted: 0,
      updated: false,
      compacted: false,
      pruned,
    };
  }

  // Step 2: Upsert candidates
  await upsertCandidates(userId, discoveryResult.claims);

  // Step 3: Promote candidates that meet criteria
  const promotable = await findPromotableCandidates(userId);
  const promoted = promotable.length;

  if (promoted === 0) {
    loggers.api.debug('Memory cron: No candidates ready for promotion', { userId });
    const pruned = await pruneStaleCandidates(userId);
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

  // Step 5: Evaluate and integrate
  const updates = await evaluateAndIntegrate(userId, promotable, currentPages);

  // Step 6: Apply updates with guards
  const applyResult = await applyIntegrationDecisions(userId, updates, currentPages);

  // Step 6b: Settle each candidate against what actually landed.
  //
  // A candidate is only PROMOTED if the page for its field was really written.
  // The evaluator can decline a claim, and the rewrite guards can reject a
  // whole field — in both cases marking the candidate promoted would retire it
  // permanently despite nothing reaching the profile, so a claim the user keeps
  // expressing would be silently dropped after its first evaluation.
  //
  // Declined claims are marked REJECTED rather than left pending: the evaluator
  // has seen them against the current profile and said no, and leaving them
  // pending would re-spend tokens re-deciding the same claim every night.
  // Guard-rejected fields stay pending so the next run can try again.
  const written = new Set(applyResult.fields);
  const guardRejected = new Set(applyResult.rejected.map((r) => r.field));

  const promotedIds: string[] = [];
  const rejectedIds: string[] = [];

  for (const candidate of promotable) {
    const field = candidate.field as MemoryField;
    if (written.has(field)) {
      promotedIds.push(candidate.id);
    } else if (!guardRejected.has(field)) {
      rejectedIds.push(candidate.id);
    }
    // else: guard-rejected — leave pending for the next run.
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
  const pruned = await pruneStaleCandidates(userId);

  loggers.api.info('Memory cron: User processed', {
    userId,
    discovered,
    promoted,
    updated: applyResult.updated,
    updatedFields: applyResult.fields,
    rejected: applyResult.rejected,
    compacted,
    pruned,
  });

  return {
    discovered,
    promoted,
    updated: applyResult.updated,
    compacted,
    pruned,
  };
}

export async function GET(request: Request) {
  return POST(request);
}
