import { db, eq, and, aiUsageDaily, users, sql } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';

export type ProviderType = 'standard' | 'pro';

export interface UsageTrackingResult {
  success: boolean;
  currentCount: number;
  limit: number;
  remainingCalls: number;
}

const usageLogger = loggers.api.child({ module: 'subscription-usage' });
const verboseUsageLogging = process.env.AI_DEBUG_LOGGING === 'true' || process.env.NODE_ENV !== 'production';

/**
 * Get usage limits based on subscription tier
 */
export function getUsageLimits(subscriptionTier: string, providerType: ProviderType): number {
  if (providerType === 'standard') {
    // Free tier: 20 calls/day, Pro tier: 100 calls/day, Business tier: 500 calls/day
    if (subscriptionTier === 'business') return 500;
    if (subscriptionTier === 'pro') return 100;
    return 20; // free tier
  }

  if (providerType === 'pro') {
    // Pro AI: 0 calls for free, 50 calls for pro, 100 calls for business
    if (subscriptionTier === 'business') return 100;
    if (subscriptionTier === 'pro') return 50;
    return 0; // free tier
  }

  return 0;
}

/**
 * Atomically increment usage count for a user and provider type
 * Returns success=false if limit exceeded
 */
export async function incrementUsage(
  userId: string,
  providerType: ProviderType
): Promise<UsageTrackingResult> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

  const maskedUserId = maskIdentifier(userId);
  const baseMetadata = {
    userId: maskedUserId,
    providerType,
    date: today
  };

  if (verboseUsageLogging) {
    usageLogger.debug('Increment usage invoked', baseMetadata);
  }

  // Get user's subscription tier
  const user = await db.select({
    subscriptionTier: users.subscriptionTier
  })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user.length) {
    usageLogger.warn('User not found when incrementing usage', baseMetadata);
    throw new Error('User not found');
  }

  const subscriptionTier = user[0].subscriptionTier;
  const limit = getUsageLimits(subscriptionTier, providerType);

  if (verboseUsageLogging) {
    usageLogger.debug('Resolved usage limits', {
      ...baseMetadata,
      subscriptionTier,
      limit
    });
  }


  // No access (free tier trying pro AI)
  if (limit === 0) {
    if (verboseUsageLogging) {
      usageLogger.debug('Usage access denied for subscription tier', {
        ...baseMetadata,
        subscriptionTier
      });
    }
    return {
      success: false,
      currentCount: 0,
      limit: 0,
      remainingCalls: 0
    };
  }

  try {
    // Atomic increment with limit check
    const result = await db
      .update(aiUsageDaily)
      .set({
        count: sql`${aiUsageDaily.count} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiUsageDaily.userId, userId),
          eq(aiUsageDaily.date, today),
          eq(aiUsageDaily.providerType, providerType),
          sql`${aiUsageDaily.count} < ${limit}`
        )
      )
      .returning({ count: aiUsageDaily.count });

    if (result.length > 0) {
      // Successfully incremented
      const currentCount = result[0].count;
      if (verboseUsageLogging) {
        usageLogger.debug('Usage incremented', {
          ...baseMetadata,
          currentCount,
          limit,
          remaining: limit - currentCount
        });
      }

      return {
        success: true,
        currentCount,
        limit,
        remainingCalls: limit - currentCount
      };
    }

    // Either limit reached or no existing record
    // Try to insert new record
    try {
      await db
        .insert(aiUsageDaily)
        .values({
          userId,
          date: today,
          providerType,
          count: 1,
        })
        .returning({ count: aiUsageDaily.count });

      if (verboseUsageLogging) {
        usageLogger.debug('Usage record created', {
          ...baseMetadata,
          currentCount: 1,
          limit,
          remaining: limit - 1
        });
      }

      return {
        success: true,
        currentCount: 1,
        limit,
        remainingCalls: limit - 1
      };

    } catch (insertError) {
      if (verboseUsageLogging) {
        usageLogger.debug('Usage record insert conflicted, reading current usage', {
          ...baseMetadata,
          error: insertError instanceof Error ? insertError.message : String(insertError)
        });
      }

      // Insert failed (likely due to conflict), check current usage
      const current = await getCurrentUsage(userId, providerType);

      if (verboseUsageLogging) {
        usageLogger.debug('Current usage after insert conflict', {
          ...baseMetadata,
          currentCount: current.currentCount,
          limit
        });
      }

      if (current.currentCount >= limit) {
        usageLogger.warn('Usage limit reached after insert conflict', {
          ...baseMetadata,
          currentCount: current.currentCount,
          limit
        });

        return {
          success: false,
          currentCount: current.currentCount,
          limit,
          remainingCalls: 0
        };
      }

      // Race condition, try atomic increment again
      const retryResult = await db
        .update(aiUsageDaily)
        .set({
          count: sql`${aiUsageDaily.count} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiUsageDaily.userId, userId),
            eq(aiUsageDaily.date, today),
            eq(aiUsageDaily.providerType, providerType),
            sql`${aiUsageDaily.count} < ${limit}`
          )
        )
        .returning({ count: aiUsageDaily.count });

      if (retryResult.length > 0) {
        const currentCount = retryResult[0].count;
        if (verboseUsageLogging) {
          usageLogger.debug('Usage increment succeeded after retry', {
            ...baseMetadata,
            currentCount,
            limit,
            remaining: limit - currentCount
          });
        }
        return {
          success: true,
          currentCount,
          limit,
          remainingCalls: limit - currentCount
        };
      }

      // Limit exceeded
      const limitReachedResult = {
        success: false,
        currentCount: current.currentCount,
        limit,
        remainingCalls: 0
      };
      usageLogger.warn('Usage limit reached during retry', {
        ...baseMetadata,
        currentCount: limitReachedResult.currentCount,
        limit
      });
      return limitReachedResult;
    }

  } catch (error) {
    usageLogger.error('Failed to increment usage', error instanceof Error ? error : undefined, baseMetadata);
    throw error;
  }
}

/**
 * Get current usage for a user and provider type
 */
export async function getCurrentUsage(
  userId: string,
  providerType: ProviderType
): Promise<UsageTrackingResult> {
  // Get user's subscription tier
  const user = await db.select({
    subscriptionTier: users.subscriptionTier
  })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user.length) {
    throw new Error('User not found');
  }

  const subscriptionTier = user[0].subscriptionTier;
  const limit = getUsageLimits(subscriptionTier, providerType);


  const today = new Date().toISOString().split('T')[0];

  const usage = await db.select({
    count: aiUsageDaily.count
  })
    .from(aiUsageDaily)
    .where(
      and(
        eq(aiUsageDaily.userId, userId),
        eq(aiUsageDaily.date, today),
        eq(aiUsageDaily.providerType, providerType)
      )
    )
    .limit(1);

  const currentCount = usage.length > 0 ? usage[0].count : 0;
  const remainingCalls = Math.max(0, limit - currentCount);

  return {
    success: currentCount < limit,
    currentCount,
    limit,
    remainingCalls
  };
}

/**
 * Get usage summary for all provider types for a user
 */
export async function getUserUsageSummary(userId: string) {
  const user = await db.select({
    subscriptionTier: users.subscriptionTier
  })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user.length) {
    throw new Error('User not found');
  }

  const subscriptionTier = user[0].subscriptionTier;
  const today = new Date().toISOString().split('T')[0];

  const usageRecords = await db.select({
    providerType: aiUsageDaily.providerType,
    count: aiUsageDaily.count
  })
    .from(aiUsageDaily)
    .where(
      and(
        eq(aiUsageDaily.userId, userId),
        eq(aiUsageDaily.date, today)
      )
    );

  const usageMap = new Map(
    usageRecords.map(record => [record.providerType as ProviderType, record.count])
  );

  const standardUsage = usageMap.get('standard') || 0;
  const proUsage = usageMap.get('pro') || 0;

  const standardLimit = getUsageLimits(subscriptionTier, 'standard');
  const proLimit = getUsageLimits(subscriptionTier, 'pro');

  return {
    subscriptionTier,
    standard: {
      current: standardUsage,
      limit: standardLimit,
      remaining: standardLimit === -1 ? -1 : Math.max(0, standardLimit - standardUsage)
    },
    pro: {
      current: proUsage,
      limit: proLimit,
      remaining: Math.max(0, proLimit - proUsage)
    }
  };
}