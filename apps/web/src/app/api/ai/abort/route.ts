import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { abortStream, abortStreamByMessageId } from '@/lib/ai/core/stream-abort-registry';
import { abortConversationStreams } from '@/lib/ai/core/abort-conversation-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

// Rate limit: 10 requests per minute per user to prevent brute-force streamId guessing
const ABORT_RATE_LIMIT = {
  maxAttempts: 10,
  windowMs: 60 * 1000, // 1 minute
  blockDurationMs: 60 * 1000, // 1 minute block
  progressiveDelay: false,
};

/**
 * POST /api/ai/abort
 *
 * Explicitly abort an AI stream by its ID.
 * Used when user clicks the stop button - distinct from client disconnect.
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat_stream', resourceId: 'abort', details: { reason: 'auth_failed', method: 'POST' }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    // Rate limiting to prevent brute-force streamId guessing.
    // Postgres-backed so the limit survives restarts and spans replicas (#977).
    const rateLimit = await checkDistributedRateLimit(`abort:${userId}`, ABORT_RATE_LIMIT);
    if (!rateLimit.allowed) {
      loggers.api.warn('AI abort rate limited', { userId, retryAfter: rateLimit.retryAfter });
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_chat_stream', resourceId: 'abort', details: { reason: 'rate_limited', method: 'POST' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: rateLimit.retryAfter
            ? { 'Retry-After': rateLimit.retryAfter.toString() }
            : undefined,
        }
      );
    }

    const body = await request.json();
    const { streamId, messageId, conversationId } = body as {
      streamId?: string;
      messageId?: string;
      conversationId?: string;
    };

    const hasStreamId = streamId && typeof streamId === 'string' && streamId.trim();
    const hasMessageId = messageId && typeof messageId === 'string' && messageId.trim();
    // The one name the client holds from t=0. Both streamId and messageId are minted SERVER-side
    // and are unknown until the response headers land — so a Stop pressed inside the 0.5-3s TTFB
    // window (auth, rate limit, DB reads, context assembly, provider connect) had NOTHING to
    // name. It cancelled the local fetch and returned; streams are deliberately server-owned and
    // survive a client disconnect, so the generation kept running, kept calling write tools, and
    // kept billing, while the button flipped back to Send. See abort-conversation-streams.ts.
    const hasConversationId =
      conversationId && typeof conversationId === 'string' && conversationId.trim();

    if (!hasStreamId && !hasMessageId && !hasConversationId) {
      return NextResponse.json(
        { error: 'streamId, messageId or conversationId is required' },
        { status: 400 }
      );
    }

    // messageId is the most precise name, then streamId; conversationId is the fallback that
    // works before either exists.
    const result = hasMessageId
      ? abortStreamByMessageId({ messageId: messageId as string, userId })
      : hasStreamId
        ? abortStream({ streamId: streamId as string, userId })
        : await abortConversationStreams({ conversationId: conversationId as string, userId })
            .then((r) => ({ aborted: r.aborted.length > 0, reason: r.reason }));

    const resourceId = hasMessageId
      ? (messageId as string)
      : hasStreamId
        ? (streamId as string)
        : (conversationId as string);

    loggers.api.info('AI stream abort requested', {
      streamId,
      messageId,
      userId,
      aborted: result.aborted,
      reason: result.reason,
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'ai_chat_stream', resourceId, details: {
      action: 'abort',
      aborted: result.aborted,
    } });

    return NextResponse.json(result);
  } catch (error) {
    loggers.api.error('Error aborting AI stream', { error });
    return NextResponse.json(
      { error: 'Failed to abort stream' },
      { status: 500 }
    );
  }
}
