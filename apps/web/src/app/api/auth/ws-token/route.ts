import { NextResponse } from 'next/server';
import { verifyAuth, getClientIP } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { getWsTokenPolicy } from '@pagespace/lib/auth/token-lifecycle-policy';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';

// SECURITY (L5): ws-tokens are narrow, user-scoped, short-lived tokens dedicated
// to desktop websocket auth — NOT a 90-day `type:'service'` `mcp:*` token (which
// the processor's service-to-service middleware would also accept). The desktop
// client re-fetches a fresh ws-token automatically on (re)connect, so a short
// TTL costs nothing operationally. See getWsTokenPolicy().

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

  const clientIP = getClientIP(request);
  const wsPolicy = getWsTokenPolicy();
  const token = await sessionService.createSession({
    userId: user.id,
    type: wsPolicy.type,
    scopes: wsPolicy.scopes,
    expiresInMs: wsPolicy.ttlMs,
    createdByService: 'desktop',
    createdByIp: clientIP,
  });
  auditRequest(request, { eventType: 'auth.token.created', userId: user.id, details: { tokenType: 'websocket' } });

  return NextResponse.json({ token });
}
