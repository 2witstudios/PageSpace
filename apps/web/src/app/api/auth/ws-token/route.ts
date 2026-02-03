import { NextResponse } from 'next/server';
import { verifyAuth, getClientIP } from '@/lib/auth';
import { sessionService } from '@pagespace/lib';
import { checkDistributedRateLimit } from '@pagespace/lib/security';

// WS tokens for desktop/mobile persistent connections need long TTL to match device sessions.
// The connection is persistent and authenticated - we don't want to kick users mid-interaction.
// Security is maintained through: session validation, fingerprint checks, and stale connection cleanup.
const WS_TOKEN_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days - matches device session lifetime

// Rate limit: 10 token requests per minute per user
const WS_TOKEN_RATE_LIMIT = {
  maxAttempts: 10,
  windowMs: 60000, // 1 minute
};

export async function POST(request: Request) {
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Per-user rate limiting to prevent token flooding
  const rateLimit = await checkDistributedRateLimit(
    `ws-token:user:${user.id}`,
    WS_TOKEN_RATE_LIMIT
  );

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: 'Too many token requests. Please try again later.',
        retryAfter: rateLimit.retryAfter,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(rateLimit.retryAfter || 60),
        },
      }
    );
  }

  const token = await sessionService.createSession({
    userId: user.id,
    type: 'service',
    scopes: ['mcp:*'],
    expiresInMs: WS_TOKEN_EXPIRY_MS,
    createdByService: 'desktop',
    createdByIp: getClientIP(request),
  });

  return NextResponse.json({ token });
}
