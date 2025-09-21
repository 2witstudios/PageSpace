import { db, eq, and, aiUsageDaily, users, sql } from '@pagespace/db';

export type ProviderType = 'normal' | 'extra_thinking';

export interface UsageTrackingResult {
  success: boolean;
  currentCount: number;
  limit: number;
  remainingCalls: number;
}

/**
 * Get usage limits based on subscription tier
 */
export function getUsageLimits(subscriptionTier: string, providerType: ProviderType): number {
  if (providerType === 'normal') {
    switch (subscriptionTier) {
      case 'free':
        return 15;
      case 'starter':
        return 50;
      case 'professional':
        return 200;
      case 'business':
        return 500;
      case 'enterprise':
        return -1; // unlimited
      default:
        return 15; // default to free
    }
  }

  if (providerType === 'extra_thinking') {
    switch (subscriptionTier) {
      case 'free':
        return 0; // no extra thinking for free
      case 'starter':
        return 10;
      case 'professional':
        return 20;
      case 'business':
        return 50;
      case 'enterprise':
        return -1; // unlimited
      default:
        return 0; // default to no access
    }
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

  console.log('🔍 incrementUsage CALLED:', {
    userId,
    providerType,
    today,
    timestamp: new Date().toISOString()
  });

  // Get user's subscription tier
  const user = await db.select({
    subscriptionTier: users.subscriptionTier
  })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user.length) {
    console.error('❌ User not found:', { userId });
    throw new Error('User not found');
  }

  const subscriptionTier = user[0].subscriptionTier;
  const limit = getUsageLimits(subscriptionTier, providerType);

  console.log('📊 User subscription info:', {
    userId,
    subscriptionTier,
    providerType,
    limit,
    today
  });

  // Unlimited usage (enterprise calls)
  if (limit === -1) {
    console.log('✅ Unlimited usage (Enterprise tier):', { userId, providerType, subscriptionTier });
    return {
      success: true,
      currentCount: 0,
      limit: -1,
      remainingCalls: -1
    };
  }

  // No access
  if (limit === 0) {
    console.log('❌ No access:', { userId, providerType, subscriptionTier });
    return {
      success: false,
      currentCount: 0,
      limit: 0,
      remainingCalls: 0
    };
  }

  try {
    console.log('🔄 Attempting atomic increment...', { userId, today, providerType, limit });

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

    console.log('📈 Atomic increment result:', { result, length: result.length });

    if (result.length > 0) {
      // Successfully incremented
      const currentCount = result[0].count;
      console.log('✅ Successfully incremented usage:', {
        userId,
        providerType,
        currentCount,
        limit,
        remaining: limit - currentCount
      });

      return {
        success: true,
        currentCount,
        limit,
        remainingCalls: limit - currentCount
      };
    }

    // Either limit reached or no existing record
    // Try to insert new record
    console.log('🆕 No existing record found, attempting to create new record...', { userId, today, providerType });

    try {
      const insertResult = await db
        .insert(aiUsageDaily)
        .values({
          userId,
          date: today,
          providerType,
          count: 1,
        })
        .returning({ count: aiUsageDaily.count });

      console.log('✅ Successfully created new usage record:', {
        userId,
        providerType,
        insertResult,
        currentCount: 1,
        limit,
        remaining: limit - 1
      });

      return {
        success: true,
        currentCount: 1,
        limit,
        remainingCalls: limit - 1
      };

    } catch (insertError) {
      console.log('⚠️ Insert failed (likely conflict), checking current usage...', {
        userId,
        providerType,
        error: insertError instanceof Error ? insertError.message : insertError
      });

      // Insert failed (likely due to conflict), check current usage
      const current = await getCurrentUsage(userId, providerType);

      console.log('📊 Current usage after insert failure:', {
        userId,
        providerType,
        currentUsage: current
      });

      if (current.currentCount >= limit) {
        console.log('❌ Limit reached after insert failure:', {
          userId,
          providerType,
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
        return {
          success: true,
          currentCount,
          limit,
          remainingCalls: limit - currentCount
        };
      }

      // Limit exceeded
      return {
        success: false,
        currentCount: current.currentCount,
        limit,
        remainingCalls: 0
      };
    }

  } catch (error) {
    console.error('Error incrementing usage:', error);
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

  // Unlimited usage
  if (limit === -1) {
    return {
      success: true,
      currentCount: 0,
      limit: -1,
      remainingCalls: -1
    };
  }

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

  const normalUsage = usageMap.get('normal') || 0;
  const extraThinkingUsage = usageMap.get('extra_thinking') || 0;

  const normalLimit = getUsageLimits(subscriptionTier, 'normal');
  const extraThinkingLimit = getUsageLimits(subscriptionTier, 'extra_thinking');

  return {
    subscriptionTier,
    normal: {
      current: normalUsage,
      limit: normalLimit,
      remaining: normalLimit === -1 ? -1 : Math.max(0, normalLimit - normalUsage)
    },
    extraThinking: {
      current: extraThinkingUsage,
      limit: extraThinkingLimit,
      remaining: extraThinkingLimit === -1 ? -1 : Math.max(0, extraThinkingLimit - extraThinkingUsage)
    }
  };
}