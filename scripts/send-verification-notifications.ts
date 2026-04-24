#!/usr/bin/env tsx
/**
 * Send email verification notifications to existing users with unverified emails
 *
 * Usage:
 *   npx tsx scripts/send-verification-notifications.ts
 *
 * This script:
 * 1. Finds all users with null emailVerified
 * 2. Creates a notification for each user
 * 3. Reports the number of notifications sent
 */

import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { eq, isNull } from '@pagespace/db/operators';
import { createNotification } from '@pagespace/lib/notifications/notifications';

async function sendVerificationNotifications() {
  console.log('🔍 Finding users with unverified emails...');

  // Find all users with unverified emails
  const unverifiedUsers = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
    })
    .from(users)
    .where(isNull(users.emailVerified));

  console.log(`📧 Found ${unverifiedUsers.length} users with unverified emails`);

  if (unverifiedUsers.length === 0) {
    console.log('✅ No users need verification notifications');
    return;
  }

  let successCount = 0;
  let errorCount = 0;

  // Send notification to each user
  for (const user of unverifiedUsers) {
    try {
      await createNotification({
        userId: user.id,
        type: 'EMAIL_VERIFICATION_REQUIRED',
        title: 'Please verify your email',
        message: 'Check your inbox for a verification link. You can resend it from your account settings.',
        metadata: {
          email: user.email,
          settingsUrl: '/settings/account',
        },
      });
      successCount++;
      console.log(`  ✓ Sent notification to ${user.email}`);
    } catch (error) {
      errorCount++;
      console.error(`  ✗ Failed to send notification to ${user.email}:`, error);
    }
  }

  console.log('\n📊 Summary:');
  console.log(`  Total users: ${unverifiedUsers.length}`);
  console.log(`  Notifications sent: ${successCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log('✅ Done!');
}

// Run the script
sendVerificationNotifications()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
