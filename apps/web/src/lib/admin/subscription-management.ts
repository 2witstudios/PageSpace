import { db, eq, users } from '@pagespace/db';
import { getStorageConfigFromSubscription } from '@pagespace/lib/services/subscription-utils';
import { loggers } from '@pagespace/lib/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';

const adminLogger = loggers.system.child({ module: 'subscription-management' });

export interface SubscriptionUpdateResult {
  success: boolean;
  user?: {
    id: string;
    subscriptionTier: string;
  };
  error?: string;
}

/**
 * Update user's subscription tier and sync storage tier
 * This function should be used for all subscription tier changes,
 * whether manual admin changes or automated processes
 */
export async function updateUserSubscriptionTier(
  userId: string,
  newTier: 'free' | 'pro' | 'business',
  adminUserId?: string
): Promise<SubscriptionUpdateResult> {
  try {
    // Validate input
    if (!userId) {
      return { success: false, error: 'User ID is required' };
    }

    if (!['free', 'pro', 'business'].includes(newTier)) {
      return { success: false, error: 'Invalid subscription tier. Must be "free", "pro", or "business"' };
    }

    // Check if user exists
    const [existingUser] = await db
      .select({
        id: users.id,
        subscriptionTier: users.subscriptionTier,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!existingUser) {
      return { success: false, error: 'User not found' };
    }

    // Check if already at the requested tier
    if (existingUser.subscriptionTier === newTier) {
      return {
        success: true,
        user: {
          id: existingUser.id,
          subscriptionTier: existingUser.subscriptionTier,
        }
      };
    }

    // Simple subscription tier update - storage limits computed dynamically
    await db
      .update(users)
      .set({
        subscriptionTier: newTier,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    // Get updated user data
    const [updatedUser] = await db
      .select({
        id: users.id,
        subscriptionTier: users.subscriptionTier,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // Compute storage config for updated tier
    const storageConfig = getStorageConfigFromSubscription(newTier);

    // Log the change
    adminLogger.info('Subscription tier updated', {
      userId: maskIdentifier(userId),
      from: existingUser.subscriptionTier,
      to: newTier,
      actor: adminUserId ? maskIdentifier(adminUserId) : 'system',
      storageUpdate: {
        tier: storageConfig.tier,
        quota: storageConfig.quotaBytes,
      },
    });

    return {
      success: true,
      user: {
        id: updatedUser!.id,
        subscriptionTier: updatedUser!.subscriptionTier,
      }
    };

  } catch (error) {
    adminLogger.error('Failed to update user subscription tier', error instanceof Error ? error : undefined, {
      userId: maskIdentifier(userId),
      attemptedTier: newTier,
      actor: adminUserId ? maskIdentifier(adminUserId) : 'system',
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

/**
 * DEPRECATED: These functions are no longer needed since storage limits are computed
 * from subscription tier dynamically. Keeping for backward compatibility.
 */

/**
 * @deprecated Storage limits are now computed from subscription tier
 */
export async function findMismatchedUsers(): Promise<never[]> {
  adminLogger.info('findMismatchedUsers is deprecated - storage limits are now computed from subscription tier');
  return [];
}

/**
 * @deprecated Storage limits are now computed from subscription tier
 */
export async function reconcileAllSubscriptionTiers(): Promise<{
  totalFixed: number;
  results: Array<{ userId: string; success: boolean; error?: string }>;
}> {
  adminLogger.info('reconcileAllSubscriptionTiers is deprecated - storage limits are now computed from subscription tier');
  return { totalFixed: 0, results: [] };
}