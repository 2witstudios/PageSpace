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

    // `globalMessagesPurged` is the ONE `messages` table — page rows as well
    // as global ones since the message-table merge (epic "Agent-Session Single
    // Source of Truth", Phase 4 / D6). The separate `chatMessagesPurged` leg
    // went with `chat_messages` when PR 15 dropped it; the field name here is
    // kept as-is so the audit-detail and response shapes stay stable for
    // anything consuming them, and the merge is described here instead.
    const globalMessagesPurged = await messageRepository.purgeInactiveMessages(thirtyDaysAgo);
    const directMessagesPurged = await dmMessageRepository.purgeInactiveMessages(thirtyDaysAgo);
    const conversationsPurged = await globalConversationRepository.purgeInactiveConversations(thirtyDaysAgo);

    console.log(
      `[Cron] Purged deleted messages: messages=${globalMessagesPurged}, direct=${directMessagesPurged}, conversations=${conversationsPurged}`
    );

    audit({
      eventType: 'data.delete',
      resourceType: 'cron_job',
      resourceId: 'purge_deleted_messages',
      details: { globalMessagesPurged, directMessagesPurged, conversationsPurged },
    });

    return NextResponse.json({
      success: true,
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
