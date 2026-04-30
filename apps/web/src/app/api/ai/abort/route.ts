import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { abortStream, abortStreamByMessageId } from '@/lib/ai/core/stream-abort-registry';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkRateLimit } from '@pagespace/lib/auth/rate-limit-utils';

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

    // Rate limiting to prevent brute-force streamId guessing
    const rateLimit = checkRateLimit(`abort:${userId}`, ABORT_RATE_LIMIT);
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
    const { streamId, messageId } = body as { streamId?: string; messageId?: string };

    const hasStreamId = streamId && typeof streamId === 'string' && streamId.trim();
    const hasMessageId = messageId && typeof messageId === 'string' && messageId.trim();

    if (!hasStreamId && !hasMessageId) {
      return NextResponse.json(
        { error: 'streamId or messageId is required' },
        { status: 400 }
      );
    }

    const result = hasMessageId
      ? abortStreamByMessageId({ messageId: messageId as string, userId })
      : abortStream({ streamId: streamId as string, userId });

    const resourceId = hasMessageId ? (messageId as string) : (streamId as string);

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
