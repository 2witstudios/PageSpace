#!/usr/bin/env tsx
/**
 * Send TOS/Privacy Policy update notifications to all users
 *
 * Usage:
 *   npx tsx scripts/send-tos-notifications.ts [tos|privacy|both]
 *
 * Examples:
 *   npx tsx scripts/send-tos-notifications.ts tos      # Notify about TOS update only
 *   npx tsx scripts/send-tos-notifications.ts privacy  # Notify about Privacy update only
 *   npx tsx scripts/send-tos-notifications.ts both     # Notify about both (default)
 *   npx tsx scripts/send-tos-notifications.ts          # Notify about both (default)
 *
 * This script:
 * 1. Finds all users in the system
 * 2. Sends TOS_PRIVACY_UPDATED notifications (in-app + email)
 * 3. Reports the number of notifications sent
 *
 * Docker usage:
 *   docker compose run --rm migrate npx tsx scripts/send-tos-notifications.ts
 */

import { broadcastTosPrivacyUpdate } from '@pagespace/lib';

async function sendTosNotifications() {
  const arg = process.argv[2]?.toLowerCase();
  const documentTypes: Array<'tos' | 'privacy'> =
    arg === 'tos' ? ['tos'] :
    arg === 'privacy' ? ['privacy'] :
    ['tos', 'privacy']; // both by default

  console.log('📢 Sending TOS/Privacy update notifications...\n');

  let totalNotifications = 0;
  let errors: string[] = [];

  for (const docType of documentTypes) {
    const docLabel = docType === 'tos' ? 'Terms of Service' : 'Privacy Policy';

    try {
      console.log(`🔔 Broadcasting ${docLabel} update notifications...`);

      const result = await broadcastTosPrivacyUpdate(docType);

      totalNotifications += result.notifiedUsers;
      console.log(`  ✓ Sent ${result.notifiedUsers} notifications for ${docLabel}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`${docLabel}: ${errorMsg}`);
      console.error(`  ✗ Failed to send ${docLabel} notifications:`, error);
    }
  }

  console.log('\n📊 Summary:');
  console.log(`  Total notifications sent: ${totalNotifications}`);
  console.log(`  Document types: ${documentTypes.join(', ')}`);

  if (errors.length > 0) {
    console.log(`  Errors: ${errors.length}`);
    errors.forEach(err => console.error(`    - ${err}`));
  }

  if (errors.length === 0) {
    console.log('✅ All notifications sent successfully!');
  } else if (totalNotifications > 0) {
    console.log('⚠️  Some notifications sent, but with errors');
  } else {
    console.log('❌ Failed to send any notifications');
  }
}

// Run the script
sendTosNotifications()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
