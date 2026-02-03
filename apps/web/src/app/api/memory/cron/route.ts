/**
 * Memory Cron Route
 *
 * Daily background process that discovers patterns from user conversations
 * and activity, then appends insights to their personalization profile.
 *
 * Pipeline:
 * 1. Get paying users with recent activity
 * 2. For each user:
 *    a. Run discovery passes (blind - doesn't see current profile)
 *    b. Run integration evaluator (sees profile, decides what to append)
 *    c. Apply approved changes
 *    d. Compact if needed
 *
 * Paying users only: 'pro', 'founder', 'business' subscription tiers
 *
 * Security: Localhost-only access (zero trust - no secret comparison)
 * Trigger via: curl http://localhost:3000/api/memory/cron
 */

import { NextResponse } from 'next/server';
import {
  db,
  users,
  userPersonalization,
  sessions,
  eq,
  and,
  gte,
  inArray,
  isNull,
} from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { validateCronRequest } from '@/lib/auth/cron-auth';
import { runDiscoveryPasses } from '@/lib/memory/discovery-service';
import {
  evaluateAndIntegrate,
  applyIntegrationDecisions,
  getCurrentPersonalization,
} from '@/lib/memory/integration-service';
import { checkAndCompactIfNeeded } from '@/lib/memory/compaction-service';

const PAYING_TIERS = ['pro', 'founder', 'business'];

const DELAY_BETWEEN_USERS_MS = 1000;

export async function POST(request: Request) {
  // Zero trust: only allow requests from localhost (no secret comparison)
  const authError = validateCronRequest(request);
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
      updated: 0,
      compacted: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const userId of usersToProcess) {
      try {
        const userResult = await processUserMemory(userId);

        results.processed++;
        if (userResult.updated) results.updated++;
        if (userResult.compacted) results.compacted++;
        if (userResult.skipped) results.skipped++;

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
      updated: results.updated,
      compacted: results.compacted,
      skipped: results.skipped,
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
): Promise<{ updated: boolean; compacted: boolean; skipped: boolean }> {
  const insights = await runDiscoveryPasses(userId);

  const totalInsights =
    insights.worldview.length +
    insights.projects.length +
    insights.communication.length +
    insights.preferences.length;

  if (totalInsights === 0) {
    loggers.api.debug('Memory cron: No insights discovered for user', { userId });
    return { updated: false, compacted: false, skipped: true };
  }

  const currentPersonalization = await getCurrentPersonalization(userId);

  const decisions = await evaluateAndIntegrate(
    userId,
    insights,
    currentPersonalization
  );

  const { updated, fields } = await applyIntegrationDecisions(
    userId,
    decisions,
    currentPersonalization
  );

  let compacted = false;
  if (updated) {
    const compactionResult = await checkAndCompactIfNeeded(userId);
    compacted = compactionResult.compacted;
  }

  loggers.api.info('Memory cron: User processed', {
    userId,
    insightCounts: {
      worldview: insights.worldview.length,
      projects: insights.projects.length,
      communication: insights.communication.length,
      preferences: insights.preferences.length,
    },
    updated,
    updatedFields: fields,
    compacted,
  });

  return { updated, compacted, skipped: false };
}

export async function GET(request: Request) {
  return POST(request);
}
