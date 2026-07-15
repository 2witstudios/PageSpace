import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { and, asc, eq } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { parseGlobalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { isStreamRowLive } from '@/lib/ai/core/stream-liveness';
import { filterSubscribableStreams } from '@/lib/ai/core/stream-subscription-authz';

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
    const scope = searchParams.get('scope');

    // scope=user: cross-channel discovery of the CALLER's own in-flight streams — what the
    // history tab (leaf 5.2) badges as "still streaming", regardless of which page/global
    // channel each one is on. Ownership IS the authz here (aiStreamSessions.userId is the
    // stream's owner column — see its docblock), so there is no page-access or
    // conversation-sharing check to run, unlike the channelId mode below. No `parts`/
    // `rawPartsCount` in the response: this mode answers "what's streaming", not "render its
    // mid-stream content" — a click-through re-fetches via includeStreaming=1 and rejoins
    // through the normal per-channel attach path.
    if (scope === 'user') {
      const now = Date.now();
      const rows = await db
        .select({
          messageId: aiStreamSessions.messageId,
          conversationId: aiStreamSessions.conversationId,
          channelId: aiStreamSessions.channelId,
          startedAt: aiStreamSessions.startedAt,
          lastHeartbeatAt: aiStreamSessions.lastHeartbeatAt,
        })
        .from(aiStreamSessions)
        .where(
          and(
            eq(aiStreamSessions.userId, userId),
            eq(aiStreamSessions.status, 'streaming'),
          )
        )
        .orderBy(asc(aiStreamSessions.startedAt), asc(aiStreamSessions.messageId));

      const live = rows.filter((r) => isStreamRowLive(r, now));

      return NextResponse.json({
        streams: live.map((s) => ({
          messageId: s.messageId,
          conversationId: s.conversationId,
          channelId: s.channelId,
          startedAt: s.startedAt.toISOString(),
        })),
      });
    }

    if (!channelId) {
      return NextResponse.json({ error: 'channelId is required (or pass scope=user)' }, { status: 400 });
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

    // Liveness is the heartbeat, and ONLY the heartbeat.
    //
    // There used to also be a `startedAt >= now - 10min` cap here, from before the
    // heartbeat existed — a crude proxy for "probably not a crashed row". It has to go:
    // this response is the authoritative answer to "what is still running on this
    // channel" (consumers reconcile their Stop-slot claims against it), and the cap made
    // that answer LIE about exactly the streams where it matters most. A deep-research or
    // long tool-loop generation is still very much alive at minute 12 — and dropping it
    // here would tell every subscriber it had ended, releasing the Stop button on a stream
    // that keeps generating and keeps billing.
    //
    // The heartbeat already covers what the cap was for: a crashed process stops beating,
    // and isStreamRowLive filters it out within STREAM_HEARTBEAT_STALE_MS.
    const now = Date.now();
    const rows = await db
      .select({
        messageId: aiStreamSessions.messageId,
        conversationId: aiStreamSessions.conversationId,
        userId: aiStreamSessions.userId,
        displayName: aiStreamSessions.displayName,
        browserSessionId: aiStreamSessions.browserSessionId,
        parts: aiStreamSessions.parts,
        rawPartsCount: aiStreamSessions.rawPartsCount,
        startedAt: aiStreamSessions.startedAt,
        lastHeartbeatAt: aiStreamSessions.lastHeartbeatAt,
      })
      .from(aiStreamSessions)
      .where(
        and(
          eq(aiStreamSessions.channelId, channelId),
          eq(aiStreamSessions.status, 'streaming'),
        )
      )
      .orderBy(asc(aiStreamSessions.startedAt), asc(aiStreamSessions.messageId));

    // Page access is not enough. A page channel carries EVERY conversation on the page,
    // and conversations are private by default — so returning every streaming row (with
    // its buffered `parts` snapshot!) to anyone who can view the page hands one member's
    // private conversation to all the others. Narrow to what this user may subscribe to:
    // their own streams, plus streams in explicitly shared conversations.
    const live = rows.filter((r) => isStreamRowLive(r, now));
    const streams = await filterSubscribableStreams({ userId, rows: live });

    return NextResponse.json({
      streams: streams.map((s) => ({
        messageId: s.messageId,
        conversationId: s.conversationId,
        startedAt: s.startedAt.toISOString(),
        // Last debounced snapshot of the stream's accumulated parts — lets the
        // client render mid-stream content immediately, without waiting on
        // (or depending on) the originator process's live multicast.
        parts: s.parts ?? [],
        // See rawPartsCount's docblock on the schema (packages/db/src/schema/ai-streams.ts)
        // for why this is NOT the same as parts.length.
        rawPartsCount: s.rawPartsCount,
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
