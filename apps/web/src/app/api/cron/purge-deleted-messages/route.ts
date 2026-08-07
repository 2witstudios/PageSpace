import { NextResponse } from 'next/server';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { messageRepository } from '@/lib/repositories/message-repository';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { dmMessageRepository } from '@pagespace/lib/services/dm-message-repository';

/**
 * Cron endpoint to hard-delete soft-deleted messages and conversations.
 *
 * Removes rows that have been soft-deleted (isActive=false) for longer than
 * 30 days, permanently freeing storage.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // `chatMessagesPurged` is the LEGACY `chat_messages` leg — still written by
    // the dual-write, read by nobody since the reader cutover (epic
    // "Agent-Session Single Source of Truth", Phase 4 / D6), and swept here
    // until PR 15 drops the table. `globalMessagesPurged` is the UNIFIED
    // `messages` table, which now holds page rows as well; the field name is
    // kept so the audit-detail and response shapes stay stable for anything
    // consuming them, and the merge is described here instead.
    const chatMessagesPurged = await messageRepository.purgeInactiveLegacyChatMessages(thirtyDaysAgo);
    const globalMessagesPurged = await messageRepository.purgeInactiveMessages(thirtyDaysAgo);
    const directMessagesPurged = await dmMessageRepository.purgeInactiveMessages(thirtyDaysAgo);
    const conversationsPurged = await globalConversationRepository.purgeInactiveConversations(thirtyDaysAgo);

    console.log(
      `[Cron] Purged deleted messages: chat=${chatMessagesPurged}, global=${globalMessagesPurged}, direct=${directMessagesPurged}, conversations=${conversationsPurged}`
    );

    audit({
      eventType: 'data.delete',
      resourceType: 'cron_job',
      resourceId: 'purge_deleted_messages',
      details: { chatMessagesPurged, globalMessagesPurged, directMessagesPurged, conversationsPurged },
    });

    return NextResponse.json({
      success: true,
      chatMessagesPurged,
      globalMessagesPurged,
      directMessagesPurged,
      conversationsPurged,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error purging deleted messages', error as Error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
