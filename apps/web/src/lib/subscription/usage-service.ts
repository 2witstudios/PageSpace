import { db, eq, users } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { rateLimitCache, type ProviderType, type UsageTrackingResult } from '@pagespace/lib';

// Re-export types for backwards compatibility
export type { ProviderType, UsageTrackingResult };

const usageLogger = loggers.api.child({ module: 'subscription-usage' });
const verboseUsageLogging = process.env.AI_DEBUG_LOGGING === 'true' || process.env.NODE_ENV !== 'production';

/**
 * Get usage limits based on subscription tier
 */
export function getUsageLimits(subscriptionTier: string, providerType: ProviderType): number {
  if (providerType === 'standard') {
    // Standard AI calls per day by tier
    if (subscriptionTier === 'business') return 1000;
    if (subscriptionTier === 'founder') return 500;
    if (subscriptionTier === 'pro') return 200;
    return 50; // free tier
  }

  if (providerType === 'pro') {
    // Pro AI calls per day by tier
    if (subscriptionTier === 'business') return 500;
    if (subscriptionTier === 'founder') return 100;
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
  const maskedUserId = maskIdentifier(userId);
  const baseMetadata = {
    userId: maskedUserId,
    providerType
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
    // Use Redis-based rate limit cache with atomic increment
    const result = await rateLimitCache.incrementUsage(userId, providerType, limit);

    if (verboseUsageLogging) {
      usageLogger.debug(result.success ? 'Usage incremented' : 'Usage limit reached', {
        ...baseMetadata,
        currentCount: result.currentCount,
        limit,
        remaining: result.remainingCalls
      });
    }

    return result;

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

  // Use Redis-based rate limit cache
  return await rateLimitCache.getCurrentUsage(userId, providerType, limit);
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

  const standardLimit = getUsageLimits(subscriptionTier, 'standard');
  const proLimit = getUsageLimits(subscriptionTier, 'pro');

  // Get current usage from Redis cache
  const standardUsageResult = await rateLimitCache.getCurrentUsage(userId, 'standard', standardLimit);
  const proUsageResult = await rateLimitCache.getCurrentUsage(userId, 'pro', proLimit);

  return {
    subscriptionTier,
    standard: {
      current: standardUsageResult.currentCount,
      limit: standardLimit,
      remaining: standardLimit === -1 ? -1 : standardUsageResult.remainingCalls
    },
    pro: {
      current: proUsageResult.currentCount,
      limit: proLimit,
      remaining: proUsageResult.remainingCalls
    }
  };
}