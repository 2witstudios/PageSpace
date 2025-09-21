import { db, eq, users } from '@pagespace/db';
import { getStorageConfigFromSubscription } from '@pagespace/lib/services/subscription-utils';

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
  newTier: 'free' | 'starter' | 'professional' | 'business' | 'enterprise',
  adminUserId?: string
): Promise<SubscriptionUpdateResult> {
  try {
    // Validate input
    if (!userId) {
      return { success: false, error: 'User ID is required' };
    }

    if (!['free', 'starter', 'professional', 'business', 'enterprise'].includes(newTier)) {
      return { success: false, error: 'Invalid subscription tier. Must be "free", "starter", "professional", "business", or "enterprise"' };
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
    console.log(`Subscription tier updated for user ${userId}:`, {
      from: existingUser.subscriptionTier,
      to: newTier,
      adminUserId: adminUserId || 'system',
      storageUpdate: {
        tier: storageConfig.tier,
        quota: storageConfig.quotaBytes,
      },
      timestamp: new Date().toISOString(),
    });

    return {
      success: true,
      user: {
        id: updatedUser!.id,
        subscriptionTier: updatedUser!.subscriptionTier,
      }
    };

  } catch (error) {
    console.error('Error updating user subscription tier:', error);
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
  console.log('findMismatchedUsers is deprecated - storage limits are now computed from subscription tier');
  return [];
}

/**
 * @deprecated Storage limits are now computed from subscription tier
 */
export async function reconcileAllSubscriptionTiers(): Promise<{
  totalFixed: number;
  results: Array<{ userId: string; success: boolean; error?: string }>;
}> {
  console.log('reconcileAllSubscriptionTiers is deprecated - storage limits are now computed from subscription tier');
  return { totalFixed: 0, results: [] };
}