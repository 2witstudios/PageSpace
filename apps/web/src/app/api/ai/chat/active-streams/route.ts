import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { and, asc, eq, gte } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    const { searchParams } = new URL(request.url);
    const channelId = searchParams.get('channelId');

    if (!channelId) {
      return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
    }

    const globalMatch = channelId.match(/^user:(.+):global$/);
    if (globalMatch) {
      if (globalMatch[1] !== userId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    } else {
      const allowed = await canUserViewPage(userId, channelId);
      if (!allowed) {
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
        tabId: aiStreamSessions.tabId,
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
          tabId: s.tabId,
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
