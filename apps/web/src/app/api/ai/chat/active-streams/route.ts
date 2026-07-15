import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { and, asc, eq } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { parseGlobalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { isStreamRowLive, isProvablyDead } from '@/lib/ai/core/stream-liveness';
import { filterSubscribableStreams } from '@/lib/ai/core/stream-subscription-authz';
import { materializeInterruptedStream } from '@/lib/ai/core/materialize-interrupted-stream';

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
    // and conversations are private by default — so acting on every streaming row (with its
    // buffered `parts` snapshot, or even just the side effect of reaping it!) for anyone who
    // can view the page hands one member's private conversation to all the others. Narrow to
    // what this user may subscribe to — their own streams, plus streams in explicitly shared
    // conversations — BEFORE either building the response or running the lazy sweep below, so
    // an unauthorized-to-that-conversation poller can't even trigger a reap side effect for a
    // conversation whose content it will never see returned.
    const authorized = await filterSubscribableStreams({ userId, rows });
    const streams = authorized.filter((r) => isStreamRowLive(r, now));

    // Lazy reap: this query already reads every 'streaming' row on the channel, so any
    // authorized-to-view row that is not live and is PROVABLY dead (never mere staleness — see
    // isProvablyDead) is reaped here rather than waiting on a cron or the next send's takeover.
    // Fire-and-forget: a channel with no more traffic on it would otherwise never trigger a
    // takeover again, and this response must not wait on a reap of rows the caller didn't even
    // ask to see.
    for (const row of authorized) {
      if (isStreamRowLive(row, now)) continue;
      if (!isProvablyDead(row, now)) continue;
      void materializeInterruptedStream({
        messageId: row.messageId,
        channelId,
        conversationId: row.conversationId,
        userId: row.userId,
        parts: row.parts,
        startedAt: row.startedAt,
      });
    }

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
