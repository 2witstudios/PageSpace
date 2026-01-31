import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { abortStream } from '@/lib/ai/core/stream-abort-registry';
import { loggers } from '@pagespace/lib/server';
import { checkRateLimit } from '@pagespace/lib/auth';

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
      return auth.error;
    }
    const userId = auth.userId;

    // Rate limiting to prevent brute-force streamId guessing
    const rateLimit = checkRateLimit(`abort:${userId}`, ABORT_RATE_LIMIT);
    if (!rateLimit.allowed) {
      loggers.api.warn('AI abort rate limited', { userId, retryAfter: rateLimit.retryAfter });
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

    const { streamId } = await request.json();

    if (!streamId || typeof streamId !== 'string') {
      return NextResponse.json(
        { error: 'streamId is required' },
        { status: 400 }
      );
    }

    const result = abortStream({ streamId, userId });

    loggers.api.info('AI stream abort requested', {
      streamId,
      userId,
      aborted: result.aborted,
      reason: result.reason,
    });

    return NextResponse.json(result);
  } catch (error) {
    loggers.api.error('Error aborting AI stream', { error });
    return NextResponse.json(
      { error: 'Failed to abort stream' },
      { status: 500 }
    );
  }
}
