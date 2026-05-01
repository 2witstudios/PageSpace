import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { and, asc, eq, gte } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { parseGlobalChannelId } from '@pagespace/lib/ai/global-channel-id';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        resourceType: 'ai_chat_stream',
        resourceId: 'active-streams',
        details: { reason: 'auth_failed', method: 'GET' },
        riskScore: 0.5,
      });
      return auth.error;
    }
    const userId = auth.userId;

    const { searchParams } = new URL(request.url);
    const channelId = searchParams.get('channelId');

    if (!channelId) {
      return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
    }

    const channelOwnerUserId = parseGlobalChannelId(channelId);
    if (channelOwnerUserId !== null) {
      if (channelOwnerUserId !== userId) {
        auditRequest(request, {
          eventType: 'authz.access.denied',
          userId,
          resourceType: 'ai_chat_stream',
          resourceId: channelId,
          details: { reason: 'global_channel_user_mismatch', method: 'GET' },
          riskScore: 0.6,
        });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    } else {
      const allowed = await canUserViewPage(userId, channelId);
      if (!allowed) {
        auditRequest(request, {
          eventType: 'authz.access.denied',
          userId,
          resourceType: 'ai_chat_stream',
          resourceId: channelId,
          details: { reason: 'page_view_denied', method: 'GET' },
          riskScore: 0.5,
        });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const streams = await db
      .select({
        messageId: aiStreamSessions.messageId,
        conversationId: aiStreamSessions.conversationId,
        userId: aiStreamSessions.userId,
        displayName: aiStreamSessions.displayName,
        browserSessionId: aiStreamSessions.browserSessionId,
      })
      .from(aiStreamSessions)
      .where(
        and(
          eq(aiStreamSessions.channelId, channelId),
          eq(aiStreamSessions.status, 'streaming'),
          gte(aiStreamSessions.startedAt, tenMinutesAgo),
        )
      )
      .orderBy(asc(aiStreamSessions.startedAt), asc(aiStreamSessions.messageId));

    return NextResponse.json({
      streams: streams.map((s) => ({
        messageId: s.messageId,
        conversationId: s.conversationId,
        triggeredBy: {
          userId: s.userId,
          displayName: s.displayName,
          browserSessionId: s.browserSessionId,
        },
      })),
    });
  } catch (error) {
    loggers.api.error('Error fetching active streams', { error });
    return NextResponse.json(
      { error: 'Failed to fetch active streams' },
      { status: 500 }
    );
  }
}
