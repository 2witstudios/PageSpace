import { db, eq, users } from '@pagespace/db';
import { updateStorageTierFromSubscription } from '@pagespace/lib/services/storage-limits';

export interface SubscriptionUpdateResult {
  success: boolean;
  user?: {
    id: string;
    subscriptionTier: string;
    storageTier: string;
    storageQuotaBytes: number;
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
  newTier: 'normal' | 'pro',
  adminUserId?: string
): Promise<SubscriptionUpdateResult> {
  try {
    // Validate input
    if (!userId) {
      return { success: false, error: 'User ID is required' };
    }

    if (!['normal', 'pro'].includes(newTier)) {
      return { success: false, error: 'Invalid subscription tier. Must be "normal" or "pro"' };
    }

    // Check if user exists
    const [existingUser] = await db
      .select({
        id: users.id,
        subscriptionTier: users.subscriptionTier,
        storageTier: users.storageTier,
        storageQuotaBytes: users.storageQuotaBytes,
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
          storageTier: existingUser.storageTier || 'free',
          storageQuotaBytes: existingUser.storageQuotaBytes || 524288000,
        }
      };
    }

    // Perform the update in a transaction to ensure consistency
    await db.transaction(async (tx) => {
      // Update subscription tier
      await tx
        .update(users)
        .set({
          subscriptionTier: newTier,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      // Update storage tier using the same logic as webhooks
      await updateStorageTierFromSubscription(userId, newTier);
    });

    // Get updated user data
    const [updatedUser] = await db
      .select({
        id: users.id,
        subscriptionTier: users.subscriptionTier,
        storageTier: users.storageTier,
        storageQuotaBytes: users.storageQuotaBytes,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // Log the change
    console.log(`Subscription tier updated for user ${userId}:`, {
      from: existingUser.subscriptionTier,
      to: newTier,
      adminUserId: adminUserId || 'system',
      storageUpdate: {
        tier: updatedUser?.storageTier,
        quota: updatedUser?.storageQuotaBytes,
      },
      timestamp: new Date().toISOString(),
    });

    return {
      success: true,
      user: {
        id: updatedUser!.id,
        subscriptionTier: updatedUser!.subscriptionTier,
        storageTier: updatedUser!.storageTier || 'free',
        storageQuotaBytes: updatedUser!.storageQuotaBytes || 524288000,
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
 * Get users with mismatched subscription and storage tiers
 * Useful for identifying users who need reconciliation
 */
export async function findMismatchedUsers(): Promise<{
  id: string;
  subscriptionTier: string;
  storageTier: string;
  storageQuotaBytes: number;
}[]> {
  const mismatchedUsers = await db
    .select({
      id: users.id,
      subscriptionTier: users.subscriptionTier,
      storageTier: users.storageTier,
      storageQuotaBytes: users.storageQuotaBytes,
    })
    .from(users)
    .where(
      // Find users where subscription tier is 'pro' but storage tier is not 'pro'
      // OR where subscription tier is 'normal' but storage tier is not 'free'
      db.or(
        db.and(
          eq(users.subscriptionTier, 'pro'),
          db.or(
            db.ne(users.storageTier, 'pro'),
            db.ne(users.storageQuotaBytes, 2147483648) // 2GB
          )
        ),
        db.and(
          eq(users.subscriptionTier, 'normal'),
          db.or(
            db.ne(users.storageTier, 'free'),
            db.ne(users.storageQuotaBytes, 524288000) // 500MB
          )
        )
      )
    );

  return mismatchedUsers;
}

/**
 * Reconcile all users with mismatched subscription/storage tiers
 * This should be run after manual subscription changes or as a maintenance task
 */
export async function reconcileAllSubscriptionTiers(): Promise<{
  totalFixed: number;
  results: Array<{
    userId: string;
    success: boolean;
    error?: string;
  }>;
}> {
  const mismatchedUsers = await findMismatchedUsers();
  const results: Array<{ userId: string; success: boolean; error?: string }> = [];

  console.log(`Found ${mismatchedUsers.length} users with mismatched subscription/storage tiers`);

  for (const user of mismatchedUsers) {
    const result = await updateUserSubscriptionTier(
      user.id,
      user.subscriptionTier as 'normal' | 'pro',
      'system-reconciliation'
    );

    results.push({
      userId: user.id,
      success: result.success,
      error: result.error,
    });

    // Small delay to avoid overwhelming the database
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const totalFixed = results.filter(r => r.success).length;

  console.log(`Reconciliation complete: ${totalFixed}/${mismatchedUsers.length} users fixed`);

  return {
    totalFixed,
    results,
  };
}